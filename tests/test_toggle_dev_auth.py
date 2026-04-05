from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import scripts.toggle_dev_auth as toggle_dev_auth


class _Args:
    def __init__(
        self,
        state: str,
        *,
        env_file: str,
        service: str = "hermes-miniapp-v4.service",
        restart: bool = False,
        ttl_minutes: int = toggle_dev_auth.DEFAULT_TTL_MINUTES,
    ) -> None:
        self.state = state
        self.env_file = env_file
        self.service = service
        self.restart = restart
        self.ttl_minutes = ttl_minutes


class ToggleDevAuthTests(unittest.TestCase):
    def _write_env(self, path: Path, content: str) -> None:
        path.write_text(content, encoding="utf-8")

    def test_on_sets_expiry_and_prints_reveal_hint(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = Path(tmpdir) / ".env"
            self._write_env(env_path, "MINIAPP_DEV_BYPASS=0\n")
            stdout = io.StringIO()
            args = _Args("on", env_file=str(env_path), ttl_minutes=10)
            with (
                mock.patch.object(toggle_dev_auth.time, "time", return_value=1_700_000_000),
                mock.patch.object(toggle_dev_auth.argparse.ArgumentParser, "parse_args", return_value=args),
                redirect_stdout(stdout),
            ):
                exit_code = toggle_dev_auth.main()

            self.assertEqual(exit_code, 0)
            lines = toggle_dev_auth.read_env_lines(env_path)
            self.assertEqual(toggle_dev_auth.get_key(lines, toggle_dev_auth.DEV_BYPASS_KEY), "1")
            self.assertEqual(
                toggle_dev_auth.get_key(lines, toggle_dev_auth.DEV_BYPASS_EXPIRES_KEY),
                str(1_700_000_000 + 600),
            )
            output = stdout.getvalue()
            self.assertIn("Dev auth is enabled but hidden until expiry.", output)
            self.assertIn("/app#dev-auth", output)
            self.assertIn("WARNING: Dev auth is ENABLED for temporary debugging only.", output)
            self.assertIn("TURN IT OFF WHEN DONE: python scripts/toggle_dev_auth.py off --restart", output)

    def test_status_reports_expired(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = Path(tmpdir) / ".env"
            self._write_env(env_path, "MINIAPP_DEV_BYPASS=1\nMINIAPP_DEV_BYPASS_EXPIRES_AT=100\n")
            stdout = io.StringIO()
            args = _Args("status", env_file=str(env_path))
            with (
                mock.patch.object(toggle_dev_auth.time, "time", return_value=200),
                mock.patch.object(toggle_dev_auth.argparse.ArgumentParser, "parse_args", return_value=args),
                redirect_stdout(stdout),
            ):
                exit_code = toggle_dev_auth.main()

            self.assertEqual(exit_code, 0)
            output = stdout.getvalue()
            self.assertIn("status=expired", output)
            self.assertIn("expires_at_utc=1970-01-01 00:01:40Z", output)
            self.assertIn("WARNING: Dev auth was left enabled long enough to expire.", output)
            self.assertIn("Turn it off when convenient: python scripts/toggle_dev_auth.py off --restart", output)
            self.assertIn("cleanup-expired --restart", output)

    def test_status_reports_active_turn_off_warning(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = Path(tmpdir) / ".env"
            self._write_env(env_path, "MINIAPP_DEV_BYPASS=1\nMINIAPP_DEV_BYPASS_EXPIRES_AT=300\n")
            stdout = io.StringIO()
            args = _Args("status", env_file=str(env_path))
            with (
                mock.patch.object(toggle_dev_auth.time, "time", return_value=200),
                mock.patch.object(toggle_dev_auth.argparse.ArgumentParser, "parse_args", return_value=args),
                redirect_stdout(stdout),
            ):
                exit_code = toggle_dev_auth.main()

            self.assertEqual(exit_code, 0)
            output = stdout.getvalue()
            self.assertIn("status=active", output)
            self.assertIn("WARNING: Dev auth is ENABLED for temporary debugging only.", output)
            self.assertIn("TURN IT OFF WHEN DONE: python scripts/toggle_dev_auth.py off --restart", output)

    def test_cleanup_expired_rewrites_env_and_can_restart(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = Path(tmpdir) / ".env"
            self._write_env(env_path, "MINIAPP_DEV_BYPASS=1\nMINIAPP_DEV_BYPASS_EXPIRES_AT=100\n")
            stdout = io.StringIO()
            args = _Args("cleanup-expired", env_file=str(env_path), restart=True, service="miniapp.service")
            with (
                mock.patch.object(toggle_dev_auth.time, "time", return_value=200),
                mock.patch.object(toggle_dev_auth, "restart_service") as restart_service,
                mock.patch.object(toggle_dev_auth.argparse.ArgumentParser, "parse_args", return_value=args),
                redirect_stdout(stdout),
            ):
                exit_code = toggle_dev_auth.main()

            self.assertEqual(exit_code, 0)
            lines = toggle_dev_auth.read_env_lines(env_path)
            self.assertEqual(toggle_dev_auth.get_key(lines, toggle_dev_auth.DEV_BYPASS_KEY), "0")
            self.assertEqual(toggle_dev_auth.get_key(lines, toggle_dev_auth.DEV_BYPASS_EXPIRES_KEY), "")
            restart_service.assert_called_once_with("miniapp.service")
            output = stdout.getvalue()
            self.assertIn("Expired dev auth config was cleaned up.", output)
            self.assertIn("Restarted miniapp.service", output)

    def test_off_clears_expiry_and_can_restart(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = Path(tmpdir) / ".env"
            self._write_env(env_path, "MINIAPP_DEV_BYPASS=1\nMINIAPP_DEV_BYPASS_EXPIRES_AT=999\n")
            stdout = io.StringIO()
            args = _Args("off", env_file=str(env_path), restart=True, service="miniapp.service")
            with (
                mock.patch.object(toggle_dev_auth, "restart_service") as restart_service,
                mock.patch.object(toggle_dev_auth.argparse.ArgumentParser, "parse_args", return_value=args),
                redirect_stdout(stdout),
            ):
                exit_code = toggle_dev_auth.main()

            self.assertEqual(exit_code, 0)
            lines = toggle_dev_auth.read_env_lines(env_path)
            self.assertEqual(toggle_dev_auth.get_key(lines, toggle_dev_auth.DEV_BYPASS_KEY), "0")
            self.assertEqual(toggle_dev_auth.get_key(lines, toggle_dev_auth.DEV_BYPASS_EXPIRES_KEY), "")
            restart_service.assert_called_once_with("miniapp.service")
            output = stdout.getvalue()
            self.assertIn("Restarted miniapp.service", output)
            self.assertIn("Dev auth is disabled. /api/dev/auth should return 404.", output)
            self.assertIn("Default safe state: leave dev auth off unless you are actively debugging.", output)


if __name__ == "__main__":
    unittest.main()
