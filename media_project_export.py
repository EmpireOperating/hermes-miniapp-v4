from __future__ import annotations

import math
import shutil
import subprocess
from pathlib import Path
from typing import Any


def _seconds(ms: int | float) -> float:
    return max(float(ms or 0) / 1000.0, 0.0)


def _escape_drawtext(value: str) -> str:
    return (
        str(value or "")
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("\n", " ")
        .replace("\r", " ")
    )


def _uploaded_asset_file(instance_path: Path, project_id: str, storage_path: str) -> Path | None:
    prefix = f"/api/media-projects/{project_id}/uploaded-assets/"
    if not str(storage_path or "").startswith(prefix):
        return None
    filename = str(storage_path)[len(prefix) :]
    if not filename or "/" in filename or ".." in filename:
        return None
    path = (instance_path / "media_project_uploads" / project_id / filename).resolve()
    root = (instance_path / "media_project_uploads" / project_id).resolve()
    if root not in path.parents or not path.is_file():
        return None
    return path


def render_media_project_to_mp4(
    *,
    project: dict[str, Any],
    tracks: list[dict[str, Any]],
    assets: list[dict[str, Any]],
    clips: list[dict[str, Any]],
    output_path: Path,
    instance_path: Path,
) -> dict[str, Any]:
    """Render a basic text/image timeline to mp4 using ffmpeg.

    This is intentionally V1-simple: uploaded image clips are overlaid on a
    black canvas for their active time range, and text clips are drawn above
    them with drawtext. Remote image URLs are skipped in this first export
    pass because ffmpeg should not fetch arbitrary network URLs from the app.
    """

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to export media projects")

    resolution = project.get("resolution") if isinstance(project.get("resolution"), dict) else {}
    width = max(int(resolution.get("width") or 1080), 1)
    height = max(int(resolution.get("height") or 1920), 1)
    fps = max(int(project.get("fps") or 30), 1)
    duration_ms = max(
        int(project.get("duration_ms") or 0),
        max((int(clip.get("start_ms") or 0) + int(clip.get("duration_ms") or 0) for clip in clips), default=0),
        1000,
    )
    duration_s = max(math.ceil(duration_ms / 100) / 10.0, 1.0)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    asset_by_id = {str(asset.get("asset_id") or ""): asset for asset in assets}
    uploaded_image_clips: list[tuple[dict[str, Any], Path]] = []
    uploaded_video_clips: list[tuple[dict[str, Any], Path]] = []
    uploaded_audio_clips: list[tuple[dict[str, Any], Path]] = []
    for clip in clips:
        clip_kind = str(clip.get("kind") or "")
        if clip_kind not in {"image", "audio", "video"}:
            continue
        asset = asset_by_id.get(str(clip.get("asset_id") or ""))
        if not asset:
            continue
        file_path = _uploaded_asset_file(Path(instance_path), str(project.get("project_id") or ""), str(asset.get("storage_path") or ""))
        if not file_path:
            continue
        if clip_kind == "image":
            uploaded_image_clips.append((clip, file_path))
        elif clip_kind == "video":
            uploaded_video_clips.append((clip, file_path))
        elif clip_kind == "audio":
            uploaded_audio_clips.append((clip, file_path))

    cmd = [
        ffmpeg,
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"color=c=black:s={width}x{height}:r={fps}:d={duration_s:.3f}",
    ]
    for clip, path in uploaded_image_clips:
        clip_duration = max(_seconds(int(clip.get("duration_ms") or 0)), 0.001)
        cmd.extend(["-loop", "1", "-t", f"{clip_duration:.3f}", "-i", str(path)])
    first_video_input_index = 1 + len(uploaded_image_clips)
    for _clip, path in uploaded_video_clips:
        cmd.extend(["-i", str(path)])
    first_audio_input_index = first_video_input_index + len(uploaded_video_clips)
    for _clip, path in uploaded_audio_clips:
        cmd.extend(["-i", str(path)])

    filters: list[str] = ["[0:v]format=yuv420p,setsar=1[base0]"]
    current_label = "base0"
    for index, (clip, _path) in enumerate(uploaded_image_clips, start=1):
        start = _seconds(int(clip.get("start_ms") or 0))
        end = _seconds(int(clip.get("start_ms") or 0) + int(clip.get("duration_ms") or 0))
        image_label = f"img{index}"
        next_label = f"base{index}"
        filters.append(
            f"[{index}:v]scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},format=rgba[{image_label}]"
        )
        filters.append(f"[{current_label}][{image_label}]overlay=0:0:enable='between(t,{start:.3f},{end:.3f})'[{next_label}]")
        current_label = next_label

    for video_offset, (clip, _path) in enumerate(uploaded_video_clips):
        input_index = first_video_input_index + video_offset
        source_in = _seconds(int(clip.get("source_in_ms") or 0))
        clip_duration = max(_seconds(int(clip.get("duration_ms") or 0)), 0.001)
        start = _seconds(int(clip.get("start_ms") or 0))
        end = _seconds(int(clip.get("start_ms") or 0) + int(clip.get("duration_ms") or 0))
        video_label = f"vid{video_offset}"
        next_label = f"basev{video_offset}"
        source_in_arg = "0" if source_in == 0 else f"{source_in:.3f}"
        filters.append(
            f"[{input_index}:v]trim=start={source_in_arg}:duration={clip_duration:.3f},setpts=PTS-STARTPTS+{start:.3f}/TB,scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},format=rgba[{video_label}]"
        )
        filters.append(f"[{current_label}][{video_label}]overlay=0:0:enable='between(t,{start:.3f},{end:.3f})'[{next_label}]")
        current_label = next_label

    text_index = 0
    for clip in clips:
        if str(clip.get("kind") or "") != "text":
            continue
        params = clip.get("params") if isinstance(clip.get("params"), dict) else {}
        raw_text = str(params.get("text") or "")
        text = _escape_drawtext(raw_text)
        if not text:
            continue
        textfile_path = output_path.parent / f"drawtext-{text_index}.txt"
        textfile_path.write_text(raw_text.replace("\r", " ").replace("\n", " "), encoding="utf-8")
        textfile = _escape_drawtext(str(textfile_path))
        start = _seconds(int(clip.get("start_ms") or 0))
        end = _seconds(int(clip.get("start_ms") or 0) + int(clip.get("duration_ms") or 0))
        next_label = f"text{text_index}"
        filters.append(
            f"[{current_label}]drawtext=textfile='{textfile}':fontcolor=white:fontsize=72:box=1:boxcolor=black@0.35:boxborderw=24:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,{start:.3f},{end:.3f})'[{next_label}]"
        )
        current_label = next_label
        text_index += 1

    audio_labels: list[str] = []
    for audio_offset, (clip, _path) in enumerate(uploaded_audio_clips):
        input_index = first_audio_input_index + audio_offset
        params = clip.get("params") if isinstance(clip.get("params"), dict) else {}
        try:
            gain = max(float(params.get("gain", 1)), 0.0)
        except (TypeError, ValueError):
            gain = 1.0
        start_ms = max(int(clip.get("start_ms") or 0), 0)
        source_in_s = max(_seconds(int(clip.get("source_in_ms") or 0)), 0.0)
        source_out_ms = int(clip.get("source_out_ms") or 0)
        clip_duration = max(_seconds(int(clip.get("duration_ms") or 0)), 0.001)
        source_out_s = source_in_s + clip_duration
        if source_out_ms > 0:
            source_out_s = max(_seconds(source_out_ms), source_in_s + 0.001)
        label = f"aud{audio_offset}"
        filters.append(
            f"[{input_index}:a]atrim={source_in_s:.3f}:{source_out_s:.3f},asetpts=PTS-STARTPTS,volume={gain:.6g},adelay={start_ms}|{start_ms}[{label}]"
        )
        audio_labels.append(label)
    if audio_labels:
        mixed_inputs = "".join(f"[{label}]" for label in audio_labels)
        filters.append(f"{mixed_inputs}amix=inputs={len(audio_labels)}:duration=longest,atrim=0:{duration_s:.3f}[aout]")

    cmd.extend([
        "-filter_complex",
        ";".join(filters),
        "-map",
        f"[{current_label}]",
    ])
    if audio_labels:
        cmd.extend(["-map", "[aout]"])
    else:
        cmd.append("-an")
    cmd.extend([
        "-t",
        f"{duration_s:.3f}",
        "-movflags",
        "+faststart",
        "-pix_fmt",
        "yuv420p",
        str(output_path),
    ])
    completed = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "ffmpeg export failed").strip()[-1000:])
    return {
        "format": "mp4",
        "duration_ms": duration_ms,
        "fps": fps,
        "resolution": {"width": width, "height": height},
        "image_clip_count": len(uploaded_image_clips),
        "audio_clip_count": len(uploaded_audio_clips),
        "video_clip_count": len(uploaded_video_clips),
        "text_clip_count": sum(1 for clip in clips if str(clip.get("kind") or "") == "text"),
    }
