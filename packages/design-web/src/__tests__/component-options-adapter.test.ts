import { applyDesignTransaction, DesignTransactionSession, type DesignOperation } from "@zeros/design-core";
import { describe, expect, it } from "vitest";

import { designWebTransactionAdapter } from "../adapter";
import { createDesignWebDocumentState } from "../revision";
import { webTransaction } from "./fixtures";

const MAIN = `<!doctype html>
<html lang="en">
  <head>
    <template data-zd-options>
      <zd-option name="width" type="number" label="Width" default="1120" min="640" max="1440" step="8" unit="px"></zd-option>
      <zd-option name="mode" type="choice" label="Mode" choices="ask plan" default="ask"></zd-option>
      <zd-option name="toolbar" type="boolean" label="Toolbar" default="true"></zd-option>
      <zd-variant name="compact" width="800"></zd-variant>
    </template>
  </head>
  <body><div data-oid="root">Composer</div></body>
</html>
`;

const state = () =>
  createDesignWebDocumentState({ documentId: "chat/composer.html", entryFile: "chat/composer.html", files: { "chat/composer.html": MAIN } });
const apply = (operations: DesignOperation[], initial = state()) => {
  const outcome = applyDesignTransaction(initial, webTransaction(initial, "options", operations), designWebTransactionAdapter);
  return { initial, outcome, file: outcome.state.files["chat/composer.html"]! };
};
const setOption = (option: string, value: string | number | boolean | null, variant: string | null = null): DesignOperation => ({
  operationId: `set-${option}-${variant ?? "default"}`, type: "component.set-option", file: "chat/composer.html", option, variant, value,
});
const diff = (before: string, after: string) => {
  const a = before.split("\n");
  const b = after.split("\n");
  return b.map((line, index) => (line === a[index] ? null : `${a[index]} -> ${line}`)).filter(Boolean);
};

describe("setting a component option on its main", () => {
  it("changes the default the main shows, in one line, and undoes exactly", () => {
    const { initial, outcome, file } = apply([setOption("width", 1080)]);
    expect(outcome.receipt.status).toBe("applied");
    expect(diff(MAIN, file)).toEqual([
      '      <zd-option name="width" type="number" label="Width" default="1120" min="640" max="1440" step="8" unit="px"></zd-option> -> ' +
        '      <zd-option name="width" type="number" label="Width" default="1080" min="640" max="1440" step="8" unit="px"></zd-option>',
    ]);
    const undone = applyDesignTransaction(outcome.state, webTransaction(outcome.state, "undo", outcome.inverseOperations), designWebTransactionAdapter);
    expect(undone.state.files["chat/composer.html"]).toBe(initial.files["chat/composer.html"]);
  });

  it("changes, adds or removes a value on the variant it shows", () => {
    expect(diff(MAIN, apply([setOption("width", 760, "compact")]).file)).toEqual([
      '      <zd-variant name="compact" width="800"></zd-variant> ->       <zd-variant name="compact" width="760"></zd-variant>',
    ]);
    expect(diff(MAIN, apply([setOption("mode", "plan", "compact")]).file)).toEqual([
      '      <zd-variant name="compact" width="800"></zd-variant> ->       <zd-variant name="compact" width="800" mode="plan"></zd-variant>',
    ]);
    expect(diff(MAIN, apply([setOption("width", null, "compact")]).file)).toEqual([
      '      <zd-variant name="compact" width="800"></zd-variant> ->       <zd-variant name="compact"></zd-variant>',
    ]);
    expect(diff(MAIN, apply([setOption("toolbar", false)]).file)).toEqual([
      '      <zd-option name="toolbar" type="boolean" label="Toolbar" default="true"></zd-option> -> ' +
        '      <zd-option name="toolbar" type="boolean" label="Toolbar" default="false"></zd-option>',
    ]);
  });

  it("writes several options in one transaction with one undo step", () => {
    const initial = state();
    const session = new DesignTransactionSession(initial, designWebTransactionAdapter);
    const after = session.apply(webTransaction(initial, "two", [setOption("width", 960), setOption("mode", "plan")])).state;
    expect(after.files["chat/composer.html"]).toContain('default="960"');
    expect(after.files["chat/composer.html"]).toContain('choices="ask plan" default="plan"');
    expect(session.undo()?.state.files["chat/composer.html"]).toBe(MAIN);
  });

  it("refuses what the declaration does not allow", () => {
    const refused = (operation: DesignOperation) => () => apply([operation]);
    expect(refused(setOption("width", 9000))).toThrow("width must be a number from 640 to 1440; 9000 does not fit.");
    expect(refused(setOption("width", "wide"))).toThrow(/width must be a number/);
    expect(refused(setOption("mode", "draw"))).toThrow(/one of ask or plan/);
    expect(refused(setOption("height", 1))).toThrow("This component has no option height.");
    expect(refused(setOption("width", 900, "huge"))).toThrow("This component has no variant huge.");
    expect(refused(setOption("width", null))).toThrow("A default cannot be removed; set another value.");
    expect(refused({ ...setOption("width", 900), file: "other.html" } as DesignOperation)).toThrow("Design component file is missing: other.html");
  });

  it("refuses a file that declares no options", () => {
    const initial = createDesignWebDocumentState({ documentId: "home.html", entryFile: "home.html", files: { "home.html": "<!doctype html><html><body></body></html>" } });
    expect(() => applyDesignTransaction(initial, webTransaction(initial, "x", [{ ...setOption("width", 900), file: "home.html" } as DesignOperation]),
      designWebTransactionAdapter)).toThrow("home.html declares no options.");
  });
});

describe("saving a variant", () => {
  const save = (name: string, values: Record<string, string | number | boolean>): DesignOperation => ({
    operationId: `save-${name}`, type: "component.save-variant", file: "chat/composer.html", name, values,
  });

  it("adds one line after the last variant, undone exactly", () => {
    const { initial, outcome, file } = apply([save("wide-plan", { width: 1280, mode: "plan", toolbar: false })]);
    expect(file).toContain(
      '      <zd-variant name="compact" width="800"></zd-variant>\n      <zd-variant name="wide-plan" width="1280" mode="plan" toolbar="false"></zd-variant>\n    </template>',
    );
    const undone = applyDesignTransaction(outcome.state, webTransaction(outcome.state, "undo", outcome.inverseOperations), designWebTransactionAdapter);
    expect(undone.state.files["chat/composer.html"]).toBe(initial.files["chat/composer.html"]);
  });

  it("refuses a name in use, Default, an unknown option or a value that does not fit", () => {
    expect(() => apply([save("compact", {})])).toThrow("The variant compact already exists.");
    expect(() => apply([save("default", {})])).toThrow(/Default is the declared defaults/);
    expect(() => apply([save("Wide", {})])).toThrow(/lowercase letters/);
    expect(() => apply([save("x", { height: 1 })])).toThrow("This component has no option height.");
    expect(() => apply([save("x", { width: 1 })])).toThrow(/640 to 1440/);
  });
});

describe("an instance's option values", () => {
  const HOST = '<!doctype html><html><body><main data-oid="m"><zd-chat-composer data-oid="ws" width="800"></zd-chat-composer></main></body></html>';
  const host = () => createDesignWebDocumentState({ documentId: "home/index.html", entryFile: "home/index.html", files: { "home/index.html": HOST } });

  it("are attributes the instance carries, set and removed in one step each", () => {
    const initial = host();
    const set = applyDesignTransaction(initial, webTransaction(initial, "w", [{
      operationId: "w", type: "node.set-attribute", nodeId: "ws", attribute: "width", value: "760",
    }, {
      operationId: "t", type: "node.set-attribute", nodeId: "ws", attribute: "toolbar", value: "false",
    }]), designWebTransactionAdapter);
    expect(set.state.files["home/index.html"]).toContain('<zd-chat-composer data-oid="ws" width="760" toolbar="false">');
    const reset = applyDesignTransaction(set.state, webTransaction(set.state, "reset", [
      { operationId: "a", type: "node.set-attribute", nodeId: "ws", attribute: "width", value: null },
      { operationId: "b", type: "node.set-attribute", nodeId: "ws", attribute: "toolbar", value: null },
    ]), designWebTransactionAdapter);
    expect(reset.state.files["home/index.html"]).toContain('<zd-chat-composer data-oid="ws">');
  });

  it("write false explicitly for a component that declares options, so it does not read as its default", () => {
    const initial = createDesignWebDocumentState({
      documentId: "home/index.html", entryFile: "home/index.html",
      files: { "home/index.html": '<!doctype html><html><body><main data-oid="m"></main></body></html>', "components/composer.html": MAIN },
      manifest: { schemaVersion: 1, parameters: [], variants: [], components: [{ id: "composer", name: "Composer", file: "components/composer.html", props: [], slots: [] }] },
    } as never);
    const created = applyDesignTransaction(initial, webTransaction(initial, "place", [{
      operationId: "p", type: "instance.create", componentId: "composer", parentNodeId: "m", instanceNodeId: "c1",
      props: { toolbar: false, width: 800 }, slotHtml: "",
    }]), designWebTransactionAdapter);
    expect(created.state.files["home/index.html"]).toContain('<zd-composer data-oid="c1" toolbar="false" width="800"></zd-composer>');
    expect(() => applyDesignTransaction(initial, webTransaction(initial, "bad", [{
      operationId: "p", type: "instance.create", componentId: "composer", parentNodeId: "m", instanceNodeId: "c1",
      props: { width: 9000 }, slotHtml: "",
    }]), designWebTransactionAdapter)).toThrow(/640 to 1440/);
  });
});
