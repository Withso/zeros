export const pagesDirectory = "apps/Product - Design";
export const pagesManifest =
  'format = "zeros-design"\nversion = 3\nid = "design_pages"\ncanvas = "canvas.json"\n';
export const pagesCanvas = {
  version: 2,
  id: "main",
  title: "Product",
  pages: [
    { id: "screens", title: "Screens", folder: "page-1", frames: ["home"] },
    {
      id: "checkout",
      title: "Checkout",
      folder: "checkout",
      frames: ["checkout_home"],
    },
    { id: "empty", title: "Empty", folder: "empty", frames: [] },
  ],
  frames: {
    home: {
      kind: "html",
      source: "page-1/home.html",
      title: "Home",
      x: 0,
      y: 0,
      width: 390,
      height: 844,
    },
    checkout_home: {
      kind: "html",
      source: "checkout/home.html",
      title: "Checkout",
      x: 0,
      y: 0,
      width: 390,
      height: 844,
    },
  },
  extension: { keep: true },
};
