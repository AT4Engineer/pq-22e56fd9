"""Guards for the on-demand price refresh (refresh.yml + the dashboard's refresh button)."""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


class TestRefreshWorkflow(unittest.TestCase):
    def setUp(self):
        self.wf = read(".github/workflows/refresh.yml")

    def test_owner_only_and_label(self):
        gate = self.wf.split("  gate:")[1].split("\n  update:")[0]
        self.assertIn("github.event.issue.user.login == 'AT4Engineer'", gate)
        self.assertIn("contains(github.event.issue.labels.*.name, 'refresh')", gate)
        self.assertIn("github.event.label.name == 'refresh'", gate)
        reject = self.wf.split("  reject:")[1]
        self.assertIn("github.event.issue.user.login != 'AT4Engineer'", reject)

    def test_reuses_update_job_and_closes(self):
        self.assertIn("uses: ./.github/workflows/update.yml", self.wf)
        self.assertIn("workflow_call:", read(".github/workflows/update.yml"))
        self.assertIn("gh issue close", self.wf)
        self.assertIn("gh issue comment", self.wf)

    def test_page_opens_refresh_issue(self):
        js = read("assets/app.js")
        self.assertIn("/issues/new?labels=refresh&title=refresh", js)
        self.assertRegex(js, r"RF_POLL_EVERY = 15000")

    def test_asset_versions_match_service_worker(self):
        html, sw = read("index.html"), read("sw.js")
        for v in re.findall(r'assets/[\w.]+\?v=\d+', html):
            self.assertIn(v, sw, v + " missing from sw.js SHELL")


if __name__ == "__main__":
    unittest.main()
