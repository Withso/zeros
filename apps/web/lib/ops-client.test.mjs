import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class ElementStub {
  constructor(id = "") {
    this.id = id;
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = "";
    this.value = "";
    this.values = {};
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  append() {}

  focus() {}

  replaceChildren() {}

  async dispatch(type) {
    const listener = this.listeners.get(type);
    assert.ok(listener, `missing ${type} listener for #${this.id}`);
    await listener({
      currentTarget: this,
      preventDefault() {},
    });
  }
}

function deletionPayload(code) {
  return {
    target: {
      kind: "account",
      maskedEmail: "a***@example.com",
      memberCount: 0,
      businessOrganization: false,
    },
    deletion: {
      state: "scheduled",
      recoveryCode: code,
      requestedAt: "2026-09-03T00:00:00.000Z",
      purgeAfter: "2026-10-03T00:00:00.000Z",
    },
  };
}

test("a completed purge does not leave the next request confirmation disabled", async () => {
  const source = await readFile(new URL("../public/ops.js", import.meta.url), "utf8");
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new ElementStub(id));
    return elements.get(id);
  };

  const root = element("root");
  root.dataset.role = "developer";
  const requestPanel = element("request-panel");
  const restoreButton = element("restore-button");
  const purgeButton = element("purge-button");
  const purgeConfirmButton = element("purge-confirm-button");
  requestPanel.querySelectorAll = (selector) => {
    assert.equal(selector, "button");
    return [restoreButton, purgeButton, purgeConfirmButton];
  };

  const lookupForm = element("lookup-form");
  lookupForm.values = {
    code: "ZD-AAAA-2222",
    supportCaseReference: "SUP-123456",
  };

  const responses = [
    deletionPayload("ZD-AAAA-2222"),
    { accepted: true },
    deletionPayload("ZD-BBBB-3333"),
  ];
  const context = vm.createContext({
    console,
    document: {
      createElement: () => new ElementStub(),
      getElementById: (id) => element(id),
      querySelector: (selector) => {
        assert.equal(selector, "main.layout");
        return root;
      },
    },
    fetch: async () => {
      const payload = responses.shift();
      assert.notEqual(payload, undefined, "unexpected request");
      return {
        ok: true,
        status: 200,
        async json() {
          return payload;
        },
      };
    },
    FormData: class {
      constructor(form) {
        this.form = form;
      }

      get(name) {
        return this.form.values[name] ?? null;
      }
    },
    HTMLSelectElement: class {},
    URL,
    window: {
      location: {
        assign() {},
        origin: "https://ops-alpha.zeros.build",
      },
    },
  });
  vm.runInContext(source, context, { filename: "ops.js" });

  await lookupForm.dispatch("submit");
  await purgeButton.dispatch("click");
  element("purge-input").value = "FORCE PURGE ZD-AAAA-2222";
  await purgeConfirmButton.dispatch("click");
  assert.equal(purgeConfirmButton.disabled, true);
  assert.equal(element("purge-confirmation").hidden, true);
  assert.equal(element("purge-input").value, "");

  lookupForm.values.code = "ZD-BBBB-3333";
  await lookupForm.dispatch("submit");
  assert.equal(element("purge-input").value, "");
  assert.equal(element("purge-confirmation").hidden, true);
  await purgeButton.dispatch("click");

  assert.equal(element("purge-confirmation").hidden, false);
  assert.equal(element("purge-phrase").textContent, "FORCE PURGE ZD-BBBB-3333");
  assert.equal(
    purgeConfirmButton.disabled,
    false,
    "the exact-confirmation action must be usable for the newly loaded request",
  );
});
