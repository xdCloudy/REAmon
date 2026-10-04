#!/usr/bin/env python3
"""Run a small real-browser regression against a running REAmon deployment."""

import os
import re
import sys

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("REAMON_BROWSER_BASE_URL", "http://127.0.0.1:3000").rstrip("/")
EMAIL = os.environ.get("REAMON_BROWSER_EMAIL", "")
PASSWORD = os.environ.get("REAMON_BROWSER_PASSWORD", "")
ACCEPTANCE_PROJECT_ID = os.environ.get("REAMON_BROWSER_PROJECT_ID", "")
FIXTURE = os.environ.get("REAMON_BROWSER_IMPORT_FIXTURE", "")

if not EMAIL or not PASSWORD:
    print("FAIL: REAMON_BROWSER_EMAIL and REAMON_BROWSER_PASSWORD are required", file=sys.stderr)
    raise SystemExit(2)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto(f"{BASE_URL}/login", wait_until="networkidle")

    # A fresh deployment can show the release-notification modal above the
    # first-use legal gate. Dismiss it so the smoke test exercises login rather
    # than timing out on a covered button.
    later = page.get_by_role("button", name="Later")
    if later.count():
        later.click()

    # Exercise the first-use legal gate when this is a fresh browser context.
    if page.get_by_role("button", name="OK, continue").count():
        page.get_by_role("button", name="OK, continue").click()
    if page.get_by_role("button", name="I Accept All Terms").count():
        for checkbox in page.locator('input[type="checkbox"]').all():
            checkbox.check()
        page.get_by_role("button", name="I Accept All Terms").click()
        page.get_by_role("button", name=re.compile(r"Let's Go", re.IGNORECASE)).click()

    expect(page.locator("#email")).to_be_visible()
    page.locator("#email").fill(EMAIL)
    page.locator("#password").fill(PASSWORD)
    page.get_by_role("button", name=re.compile(r"sign in", re.IGNORECASE)).click()
    page.wait_for_url(re.compile(r"/projects(?:/|$)"), wait_until="networkidle")
    expect(page.locator("body")).not_to_contain_text("Sign in to your account")
    expect(page.locator("body")).to_contain_text(re.compile(r"Projects|Project", re.IGNORECASE))
    page.goto(f"{BASE_URL}/projects", wait_until="networkidle")
    expect(page.locator("#email")).to_have_count(0)

    # Use the real folder/file import controls to prove that a browser
    # operator can create a native workspace and upload a bounded snapshot.
    if FIXTURE:
        page.get_by_role("link", name="New Project").click()
        page.wait_for_url(re.compile(r"/projects/new$"), wait_until="networkidle")
        page.get_by_label("Name").fill("REAmon browser import smoke")
        file_inputs = page.locator('input[type="file"]')
        expect(file_inputs).to_have_count(2)
        file_inputs.nth(1).set_input_files(FIXTURE)
        expect(page.get_by_text(re.compile(r"1 files?", re.IGNORECASE))).to_be_visible()
        page.get_by_role("button", name=re.compile(r"Create and import workspace", re.IGNORECASE)).click()
        page.wait_for_url(re.compile(r"/projects/[^/]+$"), wait_until="networkidle")
        expect(page.get_by_role("heading", name="Workspace inventory")).to_be_visible()
        expect(page.get_by_role("heading", name="Latest import")).to_be_visible()
        expect(page.locator("body")).to_contain_text("COMPLETED")

    # The staging acceptance leaves one approval-gated recovery task. Approve
    # it through the operator UI, then exercise the visible stale-recovery
    # control before the deployment-level worker drill runs.
    if ACCEPTANCE_PROJECT_ID:
        page.goto(f"{BASE_URL}/projects/{ACCEPTANCE_PROJECT_ID}", wait_until="networkidle")
        expect(page.get_by_role("heading", name="Operator approvals")).to_be_visible()
        expect(page.get_by_role("button", name="Approve")).to_have_count(1)
        page.get_by_role("button", name="Approve").click()
        expect(page.get_by_role("status")).to_contain_text(re.compile("approved", re.IGNORECASE))
        page.get_by_role("button", name="Recover stale").click()
        expect(page.get_by_role("status")).to_contain_text("No stale tasks needed recovery")

    browser.close()

print("PASS: browser login, workspace import, operator approval, and recovery controls")
