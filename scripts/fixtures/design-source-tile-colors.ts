// Test-only authored SVG/HTML colors for alpha, clipping and pixel comparison.
// These calibration inputs are not application chrome or design-system tokens.
export const designSourceTileColors = {
  chrome: "rgb(20,30,40)",
  blueAlpha: "rgba(50,120,240,.5)",
  orangeAlpha: "rgba(240,120,50,.5)",
  lightBackground: "rgb(220,230,240)",
  upperAlpha: "rgba(20,80,220,.5)",
  lowerAlpha: "rgba(240,80,20,.5)",
  overlap: ["rgba(50,80,40,.5)", "rgba(130,80,40,.5)", "rgba(210,80,40,.5)"],
  responsive: "rgb(40,120,220)",
  contextLoss: "rgba(20,120,200,.5)",
  contextLossBackground: "rgb(230,240,250)",
  outline: "rgb(150,160,180)",
  frontAlpha: "rgba(240,40,50,.5)",
};
