// Only the external WorkOS exchange is simulated; session storage, refresh
// locking, callback routing, and file notifications use production modules.
export function workOSDesktopClientForMain() {
  return {
    async refresh(input: unknown) {
      const response = await fetch(process.env.ZEROS_TEST_REFRESH_URL!, {
        method: "POST",
        body: JSON.stringify(input),
      });
      return response.json();
    },
  };
}
