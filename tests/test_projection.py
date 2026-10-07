"""Runs the JavaScript projection-math tests (tests/projection.test.js) with Node, if Node is installed."""
import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


@unittest.skipUnless(shutil.which("node"), "node not installed")
class TestProjectionMath(unittest.TestCase):
    def test_projection_js(self):
        r = subprocess.run(["node", os.path.join(HERE, "projection.test.js")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("tests passed", r.stdout)


if __name__ == "__main__":
    unittest.main()
