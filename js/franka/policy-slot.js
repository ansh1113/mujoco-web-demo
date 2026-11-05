// ───────────────────────────────────────────────────────────────────────────────
//  POLICY SLOT
//
//  The pick-and-place tab loads POLICY_SLOT.url on start; POLICY_CHOICES fills the picker.
//
//  Default: models/dp_reduced.onnx, diffusion-pick's Diffusion Policy exactly as exported
//  (exports/dp_reduced.onnx). It succeeds on 40/50 layouts in this page's renderer
//  (results/browser_eval_dp_reduced.json).
//
//  Any export following diffusion-pick's convention works without code changes: inputs are fed by
//  name (front_rgb, wrist_rgb, proprio, noise, object_state) and a <name>.json next to the .onnx is
//  read for obs_horizon / pred_horizon / img_size. You can also open  ?policy=models/x.onnx#pick
//  or use the "Load .onnx…" button in the page.
// ───────────────────────────────────────────────────────────────────────────────
export const POLICY_CHOICES = [
  { url: 'models/dp_reduced.onnx', label: 'Diffusion Policy · dp_reduced (diffusion-pick)' },
  { url: 'models/placeholder_pick.onnx', label: 'Placeholder · scripted, privileged state' },
];

export const POLICY_SLOT = POLICY_CHOICES[0];
