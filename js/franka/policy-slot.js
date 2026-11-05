// ───────────────────────────────────────────────────────────────────────────────
//  POLICY SLOT
//
//  The pick-and-place tab loads POLICY_SLOT.url on start; POLICY_CHOICES fills the picker.
//
//  Default: models/dp_v2.onnx, diffusion-pick's v2 Diffusion Policy (recovery demos + strong photometric
//  augmentation; exports/dp_v2.onnx on branch claude/dp-v2-recovery-aug). Browser eval on 50 layouts:
//  45/50, vs 43/50 for dp_browser and 40/50 for dp_reduced (results/browser_eval_*.json; README,
//  "Browser results").
//
//  Any export following diffusion-pick's convention works without code changes: inputs are fed by
//  name (front_rgb, wrist_rgb, proprio, noise, object_state) and a <name>.json next to the .onnx is
//  read for obs_horizon / pred_horizon / img_size. You can also open  ?policy=models/x.onnx#pick
//  or use the "Load .onnx…" button in the page.
// ───────────────────────────────────────────────────────────────────────────────
export const POLICY_CHOICES = [
  { url: 'models/dp_v2.onnx', label: 'Diffusion Policy v2 · recovery demos + strong aug' },
  { url: 'models/dp_browser.onnx', label: 'Diffusion Policy · v1 fine-tuned for the browser' },
  { url: 'models/dp_reduced.onnx', label: 'Diffusion Policy · v1 dp_reduced (original)' },
  { url: 'models/placeholder_pick.onnx', label: 'Placeholder · scripted, privileged state' },
];

export const POLICY_SLOT = POLICY_CHOICES[0];
