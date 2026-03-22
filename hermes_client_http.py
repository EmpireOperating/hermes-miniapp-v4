from __future__ import annotations

import json
from typing import Iterator

import requests

from hermes_client_types import HermesClientError


class HermesClientHTTPMixin:
    def _request_payload(self, user_id: str, message: str) -> dict[str, str]:
        payload = {"user_id": user_id, "message": message}
        if self.model:
            payload["model"] = self.model
        return payload

    def _ask_via_http(self, user_id: str, message: str) -> tuple[str, str]:
        payload = self._request_payload(user_id=user_id, message=message)
        headers = {"Accept": "application/json, text/event-stream;q=0.9, text/plain;q=0.7"}
        try:
            response = requests.post(self.api_url, json=payload, timeout=self.timeout_seconds, headers=headers)
            response.raise_for_status()
        except requests.RequestException as exc:
            raise HermesClientError(f"Hermes HTTP call failed: {exc}") from exc

        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            try:
                data = response.json()
            except json.JSONDecodeError as exc:
                raise HermesClientError("Hermes HTTP endpoint returned invalid JSON.") from exc
            reply_text = (data.get("reply") or data.get("text") or data.get("content") or "").strip()
            if not reply_text:
                raise HermesClientError("Hermes HTTP endpoint returned an empty reply.")
            return reply_text, "http"

        reply_text = response.text.strip()
        if not reply_text:
            raise HermesClientError("Hermes HTTP endpoint returned an empty reply.")
        return reply_text, "http-text"

    def _stream_via_http(self, url: str, user_id: str, message: str) -> Iterator[str]:
        payload = self._request_payload(user_id=user_id, message=message)
        headers = {"Accept": "text/event-stream, application/x-ndjson, text/plain"}
        try:
            with requests.post(
                url,
                json=payload,
                timeout=self.timeout_seconds,
                headers=headers,
                stream=True,
            ) as response:
                response.raise_for_status()
                content_type = response.headers.get("content-type", "")
                if "text/event-stream" in content_type:
                    yield from self._yield_sse_chunks(response)
                    return
                if "application/x-ndjson" in content_type or "application/jsonl" in content_type:
                    yield from self._yield_ndjson_chunks(response)
                    return
                yield from self._yield_raw_chunks(response)
        except requests.RequestException as exc:
            raise HermesClientError(f"Hermes stream call failed: {exc}") from exc

    def _yield_sse_chunks(self, response: requests.Response) -> Iterator[str]:
        yielded_any = False
        for line in response.iter_lines(decode_unicode=True):
            if line is None:
                continue
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith("data:"):
                data = stripped[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    payload = json.loads(data)
                    chunk = str(
                        payload.get("chunk")
                        or payload.get("text")
                        or payload.get("delta")
                        or payload.get("content")
                        or ""
                    )
                except json.JSONDecodeError:
                    chunk = data
                if chunk:
                    yielded_any = True
                    yield chunk
        if not yielded_any:
            raise HermesClientError("Hermes stream endpoint did not yield any chunks.")

    def _yield_ndjson_chunks(self, response: requests.Response) -> Iterator[str]:
        yielded_any = False
        for line in response.iter_lines(decode_unicode=True):
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            chunk = str(payload.get("chunk") or payload.get("text") or payload.get("delta") or "")
            if chunk:
                yielded_any = True
                yield chunk
        if not yielded_any:
            raise HermesClientError("Hermes NDJSON stream endpoint did not yield any chunks.")

    def _yield_raw_chunks(self, response: requests.Response) -> Iterator[str]:
        yielded_any = False
        for chunk in response.iter_content(chunk_size=max(1, self.stream_chunk_size), decode_unicode=True):
            if not chunk:
                continue
            yielded_any = True
            yield chunk
        if not yielded_any:
            raise HermesClientError("Hermes raw stream endpoint did not yield any chunks.")
