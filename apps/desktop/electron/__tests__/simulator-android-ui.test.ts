import { describe, expect, it } from "vitest";

import { androidElementType, readAndroidScreenElements } from "../devices/android-ui-elements";

const PHONE = { widthPx: 1080, heightPx: 2400, scale: 2.625 };

function node(attributes: Record<string, string>, children: string[] = []): string {
  const all = {
    index: "0",
    text: "",
    "resource-id": "",
    class: "android.widget.FrameLayout",
    package: "com.android.settings",
    "content-desc": "",
    checkable: "false",
    checked: "false",
    clickable: "false",
    enabled: "true",
    focusable: "false",
    focused: "false",
    scrollable: "false",
    "long-clickable": "false",
    password: "false",
    selected: "false",
    bounds: "[0,0][1080,2400]",
    "drawing-order": "0",
    hint: "",
    ...attributes,
  };
  const text = Object.entries(all)
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
  return children.length === 0 ? `<node ${text} />` : `<node ${text}>${children.join("")}</node>`;
}

function dump(rotation: number, children: string[]): string {
  return (
    "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>" +
    `<hierarchy rotation="${rotation}">${children.join("")}</hierarchy>` +
    "UI hierchary dumped to: /dev/tty\n"
  );
}

/** Android Settings' home screen, as `uiautomator dump` wrote it. */
const SETTINGS = dump(0, [
  node({}, [
    node({ class: "android.widget.ScrollView", bounds: "[0,0][1080,2337]" }, [
      node(
        {
          class: "android.widget.LinearLayout",
          "resource-id": "com.android.settings:id/search_action_bar",
          clickable: "true",
          bounds: "[42,84][1038,273]",
        },
        [
          node({ class: "android.widget.ImageView", bounds: "[84,147][147,210]" }),
          node({
            class: "android.widget.TextView",
            text: "Search Settings",
            "resource-id": "com.android.settings:id/search_bar_title",
            bounds: "[189,143][578,214]",
          }),
        ],
      ),
      node({ class: "android.widget.LinearLayout", clickable: "true", bounds: "[0,544][1080,736]" }, [
        node({ class: "android.widget.ImageView", bounds: "[63,598][147,682]" }),
        node({ class: "android.widget.RelativeLayout", bounds: "[189,544][1038,736]" }, [
          node({
            class: "android.widget.TextView",
            text: "Network &amp; internet",
            "resource-id": "android:id/title",
            bounds: "[221,586][566,643]",
          }),
          node({
            class: "android.widget.TextView",
            text: "Mobile, Wi\u2011Fi, hotspot",
            "resource-id": "android:id/summary",
            bounds: "[221,643][572,694]",
          }),
        ]),
      ]),
      // Scrolled out of view.
      node({ class: "android.widget.LinearLayout", clickable: "true", bounds: "[0,2391][1080,2337]" }, [
        node({ class: "android.widget.TextView", text: "Battery", bounds: "[221,2391][366,2337]" }),
      ]),
    ]),
  ]),
]);

describe("Android screen elements", () => {
  it("reads the front app's package and the elements people see, in points", () => {
    const screen = readAndroidScreenElements(SETTINGS, PHONE);
    expect(screen.appName).toBeNull();
    expect(screen.appId).toBe("com.android.settings");
    expect(screen.pid).toBeNull();
    expect(screen.space).toEqual({ width: 1080 / 2.625, height: 2400 / 2.625 });
    expect(screen.elements).toEqual([
      {
        type: "Button",
        label: "Search Settings",
        value: null,
        identifier: "com.android.settings:id/search_action_bar",
        frame: { x: 16, y: 32, width: 379.4, height: 72 },
      },
      {
        type: "StaticText",
        label: "Search Settings",
        value: null,
        identifier: "com.android.settings:id/search_bar_title",
        frame: { x: 72, y: 54.5, width: 148.2, height: 27 },
      },
      {
        type: "Button",
        label: "Network & internet, Mobile, Wi\u2011Fi, hotspot",
        value: null,
        identifier: null,
        frame: { x: 0, y: 207.2, width: 411.4, height: 73.1 },
      },
      {
        type: "StaticText",
        label: "Network & internet",
        value: null,
        identifier: "android:id/title",
        frame: { x: 84.2, y: 223.2, width: 131.4, height: 21.7 },
      },
      {
        type: "StaticText",
        label: "Mobile, Wi\u2011Fi, hotspot",
        value: null,
        identifier: "android:id/summary",
        frame: { x: 84.2, y: 245, width: 133.7, height: 19.4 },
      },
    ]);
  });

  it("names fields, switches and icon buttons, and never keeps a password", () => {
    const screen = readAndroidScreenElements(
      dump(0, [
        node({ package: "com.example.shop" }, [
          node({
            class: "android.widget.EditText",
            text: "Email",
            hint: "Email",
            clickable: "true",
            bounds: "[42,300][1038,420]",
          }),
          node({
            class: "android.widget.EditText",
            text: "ada@example.com",
            hint: "Email",
            "resource-id": "com.example.shop:id/email",
            bounds: "[42,450][1038,570]",
          }),
          node({
            class: "android.widget.EditText",
            text: "\u2022\u2022\u2022\u2022\u2022\u2022",
            hint: "Password",
            password: "true",
            bounds: "[42,600][1038,720]",
          }),
          node({
            class: "android.widget.Switch",
            checkable: "true",
            checked: "true",
            clickable: "true",
            bounds: "[900,800][1038,880]",
          }),
          node({
            class: "android.widget.ImageButton",
            "content-desc": "Navigate up",
            clickable: "true",
            bounds: "[0,84][147,231]",
          }),
          node({
            class: "android.widget.ImageView",
            "content-desc": "Profile photo",
            bounds: "[400,1000][680,1280]",
          }),
          node({ class: "android.view.View", text: "&lt;Sale&gt; &#8364;5 &#x1F600;", bounds: "[0,1300][540,1400]" }),
        ]),
      ]),
      PHONE,
    );
    expect(screen.appId).toBe("com.example.shop");
    expect(screen.elements.map(({ type, label, value }) => [type, label, value])).toEqual([
      ["TextField", "Email", null],
      ["TextField", "Email", "ada@example.com"],
      ["SecureTextField", "Password", null],
      ["Switch", null, "1"],
      ["Button", "Navigate up", null],
      ["Image", "Profile photo", null],
      ["Group", "<Sale> \u20ac5 \u{1F600}", null],
    ]);
  });

  it("measures a turned screen as it is turned", () => {
    const screen = readAndroidScreenElements(
      dump(1, [
        node({ bounds: "[0,0][2400,1080]" }, [
          node({ class: "android.widget.Button", text: "OK", bounds: "[2100,900][2310,1020]" }),
        ]),
      ]),
      PHONE,
    );
    expect(screen.space).toEqual({ width: 2400 / 2.625, height: 1080 / 2.625 });
    expect(screen.elements[0]).toMatchObject({ type: "Button", label: "OK", frame: { x: 800, y: 342.9 } });
  });

  it("reads nothing from a failed dump", () => {
    const empty = { appName: null, appId: null, pid: null, space: null, elements: [] };
    expect(readAndroidScreenElements("ERROR: could not get idle state.\n", PHONE)).toEqual(empty);
    expect(readAndroidScreenElements("", PHONE)).toEqual(empty);
    expect(readAndroidScreenElements(dump(0, []), PHONE)).toMatchObject({
      appId: null,
      elements: [],
    });
  });

  it("drops repeats and keeps a bounded list", () => {
    const button = node({
      class: "android.widget.Button",
      text: "Buy",
      package: "com.example.shop",
      bounds: "[0,0][100,100]",
    });
    const many = Array.from({ length: 700 }, (_, index) =>
      node({ class: "android.widget.Button", text: `Item ${index}`, bounds: `[0,${index}][100,${index + 50}]` }),
    );
    expect(readAndroidScreenElements(dump(0, [button, button]), PHONE).elements).toHaveLength(1);
    expect(readAndroidScreenElements(dump(0, many), PHONE).elements).toHaveLength(500);
  });

  it("maps Android classes to the iOS names", () => {
    expect(androidElementType("android.widget.TextView", false, false)).toBe("StaticText");
    expect(androidElementType("android.widget.TextView", true, false)).toBe("Button");
    expect(androidElementType("androidx.appcompat.widget.SwitchCompat", true, true)).toBe("Switch");
    expect(androidElementType("android.widget.CheckBox", true, true)).toBe("CheckBox");
    expect(androidElementType("android.widget.RadioButton", true, true)).toBe("RadioButton");
    expect(androidElementType("com.google.android.material.button.MaterialButton", true, false)).toBe(
      "Button",
    );
    expect(androidElementType("android.widget.SeekBar", false, false)).toBe("Slider");
    expect(androidElementType("android.webkit.WebView", false, false)).toBe("WebView");
    expect(androidElementType("androidx.recyclerview.widget.RecyclerView", false, false)).toBe(
      "ScrollArea",
    );
    expect(androidElementType("android.view.View", false, true)).toBe("CheckBox");
    expect(androidElementType("android.widget.LinearLayout", false, false)).toBe("Group");
  });

  it("tells a switch from a view switcher", () => {
    for (const className of [
      "android.widget.Switch",
      "androidx.appcompat.widget.SwitchCompat",
      "com.google.android.material.switchmaterial.SwitchMaterial",
      "com.google.android.material.materialswitch.MaterialSwitch",
      "android.widget.ToggleButton",
    ]) {
      expect(androidElementType(className, true, true), className).toBe("Switch");
    }
    expect(androidElementType("android.widget.ViewSwitcher", false, false)).toBe("Group");
    expect(androidElementType("android.widget.TextSwitcher", false, false)).toBe("Group");
    expect(androidElementType("android.widget.ImageSwitcher", true, false)).toBe("Button");
  });
});
