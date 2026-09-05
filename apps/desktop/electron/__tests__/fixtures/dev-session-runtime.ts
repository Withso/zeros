/** Substitute only the external WorkOS exchange; session storage, refresh
 * locking, callback routing, and file notifications use production modules. */
export function workOSDesktopClientForMain() {
  return {
    /** Send refreshes to the test server so it can count cross-process rotation. */
    async refresh(input: unknown) {
      const response = await fetch(process.env.ZEROS_TEST_REFRESH_URL!, {
        method: "POST",
        body: JSON.stringify(input),
      });
      return response.json();
    },
  };
}
