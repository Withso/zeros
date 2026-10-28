import { expect, it } from "vitest";
import { appDocumentPolicy } from "../app-document-security";

it("uses exact development origins and native main-frame ownership", () => {
  const policy = appDocumentPolicy({ devUrl: "http://localhost:5193", documentUrl: "file:///app/dist/index.html" });
  const request = { owned: true, isMainFrame: true, currentUrl: "http://localhost:5193/", requestingUrl: "http://localhost:5193/", requestingOrigin: "http://localhost:5193" };
  expect(policy.request(request)).toBe(true);
  for (const requestingUrl of ["", "null", "http://localhost:51930/", "http://localhost:5193.evil.test/", "file:///tmp/other.html", "data:text/html,hello"]) {
    expect(policy.request({ ...request, requestingUrl })).toBe(false);
  }
  expect(policy.request({ ...request, owned: false })).toBe(false);
  expect(policy.request({ ...request, isMainFrame: false })).toBe(false);
  expect(policy.request({ ...request, requestingOrigin: "null" })).toBe(false);
});

it("accepts only the packaged document with proven frame identity", () => {
  const policy = appDocumentPolicy({ documentUrl: "file:///app/dist/index.html" });
  const request = { owned: true, isMainFrame: true, currentUrl: "file:///app/dist/index.html#chat", requestingUrl: "file:///app/dist/index.html", requestingOrigin: "file://" };
  expect(policy.request(request)).toBe(true);
  for (const requestingUrl of ["file:///tmp/other.html", "file:///app/dist/index.html.evil", "file://foreign/app/dist/index.html", "null", ""]) {
    expect(policy.request({ ...request, requestingUrl })).toBe(false);
  }
  expect(policy.request({ ...request, currentUrl: "file:///tmp/other.html" })).toBe(false);
  expect(policy.request({ ...request, isMainFrame: undefined })).toBe(false);
});
