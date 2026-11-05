// ───────────────────────────────────────────────────────────────────────────────
//  POLICY SLOT
//
//  The pick-and-place tab loads whatever ONNX model `url` points to. The default is a scripted
//  placeholder. To use the Diffusion Policy from github.com/ansh1113/diffusion-pick:
//
//    cp ../diffusion-pick/exports/dp_reduced.onnx ../diffusion-pick/exports/dp_reduced.json models/
//
//  and set   url: 'models/dp_reduced.onnx'   below (the .json next to it is picked up
//  automatically: obs_horizon, pred_horizon, img_size, ...). No other code changes are needed —
//  inputs are fed by name (front_rgb, wrist_rgb, proprio, noise, object_state).
//
//  Without editing this file you can also open  index.html?policy=models/dp_reduced.onnx#pick
//  or use the "Load .onnx…" button in the page.
// ───────────────────────────────────────────────────────────────────────────────
export const POLICY_SLOT = {
  url: 'models/placeholder_pick.onnx',
  label: 'Placeholder · scripted, privileged state',
};
