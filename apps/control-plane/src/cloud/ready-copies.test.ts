import { expect, it } from "vitest";
import { READY_COPY_SECRET_PATHS, READY_COPY_SECRET_SEARCH_COMMAND, readyCopySecretLocation } from "./ready-copies.js";

const value = "npm_fixture_secret_d1a0";

it("shows where a secret was left, withholding any name that is or holds part of one", () => {
  expect(readyCopySecretLocation("/home/user/withso/zeros/.npmrc\n", [value])).toBe("/home/user/withso/zeros/.npmrc");
  expect(readyCopySecretLocation(`/root/${value}/config`, [value])).toBe("/root/… (a name there contains a build secret)");
  // A name cut short still holds part of the value.
  expect(readyCopySecretLocation(`/tmp/${value.slice(0, 9)}`, [value])).toBe("/tmp/… (a name there contains a build secret)");
  expect(readyCopySecretLocation(`/etc/x${value}y.conf`, [value])).toBe("/etc/… (a name there contains a build secret)");
  expect(readyCopySecretLocation("relative/path", [value])).toBe("a file whose name cannot be shown");
  expect(readyCopySecretLocation("/tmp/bad\u0007name", [value])).toBe("a file whose name cannot be shown");
  // A newline in a name ends the printed line: only the first line is ever read.
  expect(readyCopySecretLocation(`/tmp/first\n${value}`, [value])).toBe("/tmp/first");
});

it("searches every place a setup can write that a fork keeps, as one command taking its patterns on standard input", () => {
  expect([...READY_COPY_SECRET_PATHS]).toEqual(["/home/user", "/tmp", "/etc", "/usr/local", "/opt", "/srv", "/root", "/var"]);
  expect(READY_COPY_SECRET_SEARCH_COMMAND).toMatch(/^sudo -n bash -c '.*'$/);
  expect(READY_COPY_SECRET_SEARCH_COMMAND).toContain("grep -rlsIF -f - /home/user /tmp /etc /usr/local /opt /srv /root /var");
});
