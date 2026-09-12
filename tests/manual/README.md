# Manual notification acceptance

`npx playwright test --config tests/manual/push-native.config.ts` tests the actual browser notification API and worker restart, not a remote push provider. It requires a browser environment that genuinely grants notification permission. The ordinary CI suite separately tests real IndexedDB migration/commit, synthetic UI enrollment, and worker logic without claiming OS notification permission.

Observed 2026-09-11: the installed HeadlessChrome 153.0.8010.12 reports Permissions API `granted` but Notification API `denied`, also on a fresh blank HTTP server with no product code. The real notification probe therefore FAILED its permission prerequisite. No launch flags, host permissions, or safety controls were changed to defeat that boundary. Its failed logs remain in the issue evidence; it is not counted as a passing phone or provider test.

Required final device acceptance: install/open the PWA, explicitly allow notifications, enroll the selected Mac, request a test, close the PWA, observe the device notification, then verify click, opt-out and logout behavior. Separately observe push-service acceptance; neither result substitutes for the other. Actual earned-reset consumption is outside this test.
