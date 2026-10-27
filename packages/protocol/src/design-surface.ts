import { DESIGN_STATIC_RENDER_CSS, DESIGN_STILL_TIMELINES_SOURCE } from "./design-capture";
import { DESIGN_SURFACE_VECTOR_SOURCE } from "./design-surface-vector";

/** Admission estimates for passive HTML, separate from editing runtimes and
 * raster leases. Missing/unknown costs keep the existing preview path. */
export interface DesignSurfaceCost {
  sourceBytes: number;
  nodes: number;
  imageBytes: number;
}

export const DESIGN_SURFACE_READY = "zeros-design-surface-ready";
export const DESIGN_SURFACE_LAYOUT = "zeros-design-surface-layout";
export const DESIGN_SURFACE_LAYOUT_REQUEST = "zeros-design-surface-layout-request";
export const DESIGN_SOURCE_SURFACES_CAPABILITY = "design.source-surfaces.v1";

// The first important layer wins over later authored layers, including rules
// that become active after a viewport resize. Insert before authored styles.
export const DESIGN_SURFACE_STATIC_CSS = `@layer{${DESIGN_STATIC_RENDER_CSS}}`;

/** No observers, recurring work, editing commands or captures. The host checks
 * both the sending Window and this exact generation before revealing it. */
export function designSurfaceReadyScript(sourceVersion: string, theme: string | null, vector = false): string {
  if (!/^[a-f0-9]{24}$/.test(sourceVersion) ||
      (theme !== null && !/^[a-z][a-z0-9_-]{0,63}$/.test(theme)))
    throw new Error("Invalid Design surface identity.");
  return `(function(){
    ${DESIGN_STILL_TIMELINES_SOURCE}
    ${vector ? DESIGN_SURFACE_VECTOR_SOURCE : ""}
    function ready(){
      stillAuthoredTimelines();
      Array.from(document.querySelectorAll("[style]")).forEach(function(element){
        element.style.setProperty("animation","none","important");
        element.style.setProperty("transition","none","important");
        element.style.setProperty("caret-color","transparent","important");
      });
      // Hidden cross-process frames can defer image.decode() until painting.
      // Resource load plus synchronous first-paint decoding avoids making
      // visibility depend on that same paint. Admission bounds image costs.
      var images=Array.from(document.images,function(image){
        image.loading="eager";
        image.decoding="sync";
        if(image.complete)return Promise.resolve();
        return new Promise(function(resolve){
          function settled(){image.removeEventListener("load",settled);image.removeEventListener("error",settled);resolve();}
          image.addEventListener("load",settled,{once:true});
          image.addEventListener("error",settled,{once:true});
        });
      });
      var viewportReady=${vector ? `new Promise(function(resolve){
        // A newly attached native child can load at 0x0 before Electron
        // delivers its viewport. Request one parent paint as well as listening
        // for resize: a remote child can receive geometry without that event.
        function measured(){
          if (!(innerWidth > 0 && innerHeight > 0)) return false;
          window.removeEventListener("resize",measured);
          window.removeEventListener("message",parentLayout);
          resolve();
          return true;
        }
        function parentLayout(event){
          if (event.source !== parent || !event.data || event.data.kind !== ${JSON.stringify(DESIGN_SURFACE_LAYOUT)} ||
              event.data.sourceVersion !== ${JSON.stringify(sourceVersion)} || event.data.theme !== ${JSON.stringify(theme)}) return;
          measured();
        }
        window.addEventListener("resize",measured);
        window.addEventListener("message",parentLayout);
        if (!measured()) parent.postMessage({kind:${JSON.stringify(DESIGN_SURFACE_LAYOUT_REQUEST)},
          sourceVersion:${JSON.stringify(sourceVersion)},theme:${JSON.stringify(theme)},
          viewport:{width:innerWidth,height:innerHeight,
            rootWidth:document.documentElement.clientWidth,rootHeight:document.documentElement.clientHeight}},"*");
      })` : "Promise.resolve()"};
      viewportReady.then(function(){
          // The delivered viewport may select different fonts in media rules.
          document.documentElement.getBoundingClientRect();
          return Promise.all([document.fonts.ready].concat(images));
        }).then(function(){
          // A hidden sandbox may not receive animation frames. Resolve layout
          // once after decoding; its host reveals it in the next paint.
          document.documentElement.getBoundingClientRect();
          var message={kind:${JSON.stringify(DESIGN_SURFACE_READY)},sourceVersion:${JSON.stringify(sourceVersion)},theme:${JSON.stringify(theme)}};
          ${vector ? "try { message.svg=designSurfaceVector(); } catch (_error) { message.svg=null; }" : ""}
          parent.postMessage(message,"*");
        });
    }
    if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready,{once:true});else ready();
  })();`;
}
