// ───────────────────────────────────────────────────────────────────────────────
//  POLICY SLOT
//
//  The pick-and-place tab loads POLICY_SLOT.url on start; POLICY_CHOICES fills the picker.
//
//  Default: models/dp_browser.onnx, diffusion-pick's Diffusion Policy (dp_reduced) fine-tuned on a
//  50/50 mix of its original MuJoCo-rendered demos and the same demos re-rendered by this page's
//  three.js renderer (see README, "Closing the render gap").
//
//  Any export following diffusion-pick's convention works without code changes: inputs are fed by
//  name (front_rgb, wrist_rgb, proprio, noise, object_state) and a <name>.json next to the .onnx is
//  read for obs_horizon / pred_horizon / img_size. You can also open  ?policy=models/x.onnx#pick
//  or use the "Load .onnx…" button in the page.
// ───────────────────────────────────────────────────────────────────────────────
export const POLICY_CHOICES = [
  { url: 'models/dp_browser.onnx', label: 'Diffusion Policy · fine-tuned for the browser' },
  { url: 'models/placeholder_pick.onnx', label: 'Placeholder · scripted, privileged state' },
];

// dp_browser.onnx is added once fine-tuning finishes; until then the placeholder is the default.
export const POLICY_SLOT = POLICY_CHOICES[1];
