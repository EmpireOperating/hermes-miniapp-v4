from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import media_project_export


def test_render_media_project_to_mp4_handles_apostrophes_in_text(tmp_path) -> None:
    output_path = tmp_path / "apostrophe.mp4"

    metadata = media_project_export.render_media_project_to_mp4(
        project={"project_id": "proj_text", "duration_ms": 1000, "resolution": {"width": 160, "height": 90}, "fps": 12},
        tracks=[{"track_id": "track_text", "kind": "text"}],
        assets=[],
        clips=[
            {
                "clip_id": "clip_text",
                "kind": "text",
                "track_id": "track_text",
                "start_ms": 0,
                "duration_ms": 1000,
                "params": {"text": "Bob's launch: day 1"},
            }
        ],
        output_path=output_path,
        instance_path=tmp_path,
    )

    assert metadata["text_clip_count"] == 1
    assert output_path.is_file()
    assert output_path.stat().st_size > 0


def test_render_media_project_to_mp4_mixes_uploaded_audio_clips(monkeypatch, tmp_path) -> None:
    instance_path = tmp_path / "instance"
    upload_dir = instance_path / "media_project_uploads" / "proj_audio"
    upload_dir.mkdir(parents=True)
    audio_path = upload_dir / "music.mp3"
    audio_path.write_bytes(b"ID3" + b"\x00" * 64)
    output_path = tmp_path / "out.mp4"
    captured = {}

    monkeypatch.setattr(media_project_export.shutil, "which", lambda name: "/usr/bin/ffmpeg")

    def fake_run(cmd, capture_output, text, timeout, check):
        captured["cmd"] = cmd
        output_path.write_bytes(b"fake mp4")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(media_project_export.subprocess, "run", fake_run)

    metadata = media_project_export.render_media_project_to_mp4(
        project={"project_id": "proj_audio", "duration_ms": 3000, "resolution": {"width": 320, "height": 180}, "fps": 24},
        tracks=[{"track_id": "track_audio", "kind": "audio"}],
        assets=[{"asset_id": "asset_audio", "kind": "audio", "storage_path": "/api/media-projects/proj_audio/uploaded-assets/music.mp3"}],
        clips=[{"clip_id": "clip_audio", "kind": "audio", "asset_id": "asset_audio", "start_ms": 500, "duration_ms": 2000, "source_in_ms": 750, "source_out_ms": 2750, "params": {"gain": 0.25}}],
        output_path=output_path,
        instance_path=instance_path,
    )

    cmd = captured["cmd"]
    joined = " ".join(cmd)
    assert str(audio_path) in cmd
    assert "-map" in cmd
    assert "[aout]" in cmd
    assert "atrim=0.750:2.750" in joined
    assert "adelay=500|500" in joined
    assert "volume=0.25" in joined
    assert "amix=inputs=1" in joined
    assert metadata["audio_clip_count"] == 1


def test_render_media_project_to_mp4_overlays_uploaded_video_clips(monkeypatch, tmp_path) -> None:
    instance_path = tmp_path / "instance"
    upload_dir = instance_path / "media_project_uploads" / "proj_video"
    upload_dir.mkdir(parents=True)
    video_path = upload_dir / "shot.mp4"
    video_path.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 64)
    output_path = tmp_path / "out.mp4"
    output_path.write_bytes(b"")
    captured = {}

    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/ffmpeg" if name == "ffmpeg" else None)

    def fake_run(cmd, capture_output, text, timeout, check):
        captured["cmd"] = cmd
        output_path.write_bytes(b"fake mp4")
        class Completed:
            returncode = 0
            stdout = ""
            stderr = ""
        return Completed()

    monkeypatch.setattr("subprocess.run", fake_run)
    from media_project_export import render_media_project_to_mp4

    metadata = render_media_project_to_mp4(
        project={"project_id": "proj_video", "duration_ms": 3000, "resolution": {"width": 320, "height": 180}, "fps": 24},
        tracks=[{"track_id": "track_visual", "kind": "visual"}],
        assets=[{"asset_id": "asset_video", "kind": "video", "storage_path": "/api/media-projects/proj_video/uploaded-assets/shot.mp4"}],
        clips=[{"clip_id": "clip_video", "kind": "video", "asset_id": "asset_video", "start_ms": 500, "duration_ms": 2000, "params": {"fit": "cover"}}],
        output_path=output_path,
        instance_path=instance_path,
    )

    cmd = " ".join(captured["cmd"])
    assert str(video_path) in cmd
    assert "trim=start=0:duration=2.000" in cmd
    assert "setpts=PTS-STARTPTS+0.500/TB" in cmd
    assert "overlay=0:0:enable='between(t,0.500,2.500)'" in cmd
    assert metadata["video_clip_count"] == 1
