import { describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { DESIGN_RUNTIME_SOURCE, type DesignRuntimeNodeDetails } from "../design-runtime";

describe("layout drag geometry", () => {
  it("reports full parent and border affine maps without flattening unsupported transforms", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const result = await page.evaluate((source) => new Promise<{
        details: Array<DesignRuntimeNodeDetails & { parentCoordinateSpace?: number[] | null; borderCoordinateSpace?: number[] | null }>;
        corners: Array<{ x: number; y: number }>;
      }>((resolve, reject) => {
        document.head.innerHTML = "<style>body{margin:0}*{box-sizing:border-box}</style>";
        document.body.innerHTML = '<main data-oid="root" style="position:relative;width:1200px;height:900px"><div data-oid="parent" style="position:absolute;left:400px;top:200px;width:300px;height:200px;border:10px solid;transform:rotate(30deg) scale(-2,3);transform-origin:0 0"><div data-oid="child" style="position:absolute;left:20px;top:30px;width:100px;height:80px;transform:rotate(15deg);transform-origin:0 0"></div></div><div data-oid="singular" style="width:10px;height:10px;transform:scale(0)"></div><div style="perspective:500px"><div data-oid="perspective" style="width:10px;height:10px;transform:rotateY(20deg)"></div></div></main>';
        const staticParent = document.createElement("div");
        staticParent.style.marginLeft = "200px";
        staticParent.innerHTML = '<div data-oid="static-child" style="position:absolute;left:20px;top:30px;width:40px;height:30px"></div>';
        document.querySelector('[data-oid="root"]')!.append(staticParent);
        const element = document.querySelector('[data-oid="child"]')!;
        const corners = [[0, 0], [100, 0], [100, 80], [0, 80]].map(([x, y]) => {
          const marker = document.createElement("i");
          marker.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`;
          element.appendChild(marker);
          const rect = marker.getBoundingClientRect();
          marker.remove();
          return { x: rect.x, y: rect.y };
        });
        const sourceVersion = "b".repeat(24);
        Object.assign(window, { __zerosDesignSourceVersion: sourceVersion });
        const channel = new MessageChannel();
        const timeout = window.setTimeout(() => reject(new Error("Affine geometry timed out")), 3_000);
        const ids = ["child", "singular", "perspective", "static-child"];
        const details: DesignRuntimeNodeDetails[] = [];
        const request = () => channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request", sourceVersion, requestId: ids[details.length], method: "getNodeDetails", args: { nodeId: ids[details.length] } });
        channel.port1.onmessage = ({ data }) => {
          if (data.event === "ready") request();
          else if (data.type === "response") {
            if (!data.ok) { reject(new Error(data.error?.message)); return; }
            details.push(data.result);
            if (details.length < ids.length) request();
            else { window.clearTimeout(timeout); channel.port1.close(); resolve({ details, corners }); }
          }
        };
        channel.port1.start();
        new Function(source)();
        window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion }, "*", [channel.port2]);
      }), DESIGN_RUNTIME_SOURCE);
      const child = result.details[0]!;
      expect(child.parentCoordinateSpace).toHaveLength(6);
      const matrix = child.borderCoordinateSpace;
      expect(matrix).toHaveLength(6);
      for (const [index, [x, y]] of [[0, 0], [100, 0], [100, 80], [0, 80]].entries()) {
        expect(matrix![0]! * x! + matrix![2]! * y! + matrix![4]!).toBeCloseTo(result.corners[index]!.x, 3);
        expect(matrix![1]! * x! + matrix![3]! * y! + matrix![5]!).toBeCloseTo(result.corners[index]!.y, 3);
      }
      expect(result.details[1]!.borderCoordinateSpace).toBeNull();
      expect(result.details[2]!.borderCoordinateSpace).toBeNull();
      expect(result.details[3]!.parentCoordinateSpace).toEqual([1, 0, 0, 1, 0, 0]);
    } finally {
      await browser.close();
    }
  });

  it("retains the moving child's margins through the bounded target snapshot", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const targets = await page.evaluate((source) => new Promise<DesignRuntimeNodeDetails[]>((resolve, reject) => {
        document.head.innerHTML = "<style>body{margin:0}*{box-sizing:border-box}</style>";
        document.body.innerHTML = '<main data-oid="parent" style="position:relative;display:flex;width:600px;height:400px"><div data-oid="child" style="position:absolute;left:100px;top:50px;width:100px;height:80px;margin:5px 7px 9px 20px"></div></main>';
        const sourceVersion = "a".repeat(24);
        Object.assign(window, { __zerosDesignSourceVersion: sourceVersion });
        const channel = new MessageChannel();
        const timeout = window.setTimeout(() => reject(new Error("Layout targets timed out")), 3_000);
        channel.port1.onmessage = ({ data }) => {
          if (data.event === "ready") {
            channel.port1.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "request", sourceVersion, requestId: "targets", method: "getLayoutTargets", args: { nodeId: "child" } });
          } else if (data.type === "response" && data.requestId === "targets") {
            window.clearTimeout(timeout);
            channel.port1.close();
            if (data.ok) resolve(data.result);
            else reject(new Error(data.error?.message ?? "Layout targets failed"));
          }
        };
        channel.port1.start();
        new Function(source)();
        window.postMessage({ protocol: "zeros-design-runtime", version: 2, type: "handshake", sourceVersion }, "*", [channel.port2]);
      }), DESIGN_RUNTIME_SOURCE);
      expect(targets.find((target) => target.oid === "child")?.styles).toMatchObject({
        marginLeft: "20px",
        marginTop: "5px",
        marginRight: "7px",
        marginBottom: "9px",
      });
    } finally {
      await browser.close();
    }
  });
});
