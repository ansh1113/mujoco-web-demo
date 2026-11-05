// ───────────────────────────────────────────────────────────────────────────────
//  POLICY SLOT
//
//  The pick-and-place tab loads POLICY_SLOT.url on start; POLICY_CHOICES fills the picker.
//
//  Default: models/dp_browser.onnx, diffusion-pick's dp_reduced fine-tuned on a 50/50 mix of its
//  MuJoCo-rendered demos and the same demos re-rendered by this page (README, "Closing the render
//  gap"). Browser eval on 50 layouts: 43/50, vs 40/50 for dp_reduced (results/browser_eval_*.json).
//
//  Any export following diffusion-pick's convention works without code changes: inputs are fed by
//  name (front_rgb, wrist_rgb, proprio, noise, object_state) and a <name>.json next to the .onnx is
//  read for obs_horizon / pred_horizon / img_size. You can also open  ?policy=models/x.onnx#pick
//  or use the "Load .onnx…" button in the page.
// ───────────────────────────────────────────────────────────────────────────────
export const POLICY_CHOICES = [
  { url: 'models/dp_browser.onnx', label: 'Diffusion Policy · fine-tuned for the browser' },
  { url: 'models/dp_reduced.onnx', label: 'Diffusion Policy · dp_reduced (original)' },
  { url: 'models/placeholder_pick.onnx', label: 'Placeholder · scripted, privileged state' },
];

export const POLICY_SLOT = POLICY_CHOICES[0];
