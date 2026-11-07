/** The Edit buttons, and the text sent to a service. Each button is only a prompt: a brush always helps, and is never required by the button. */

export type EditPresetId = "erase" | "add" | "replace" | "fix" | "unblur" | "enhance" | "free";

export interface EditPreset {
  id: EditPresetId;
  label: string;
  title: string;
  /** Text placed in the box; the user can change it. */
  text: string;
  /** Its text says "it", so without a brush the user must say what. */
  pointsAtBrush: boolean;
  needsText: boolean;
}

export const EDIT_PRESETS: readonly EditPreset[] = [
  { id: "erase", label: "Erase", title: "Brush what should go, or write it, such as: remove the crowd", text: "Remove it and fill the area so it matches its surroundings. Do not add anything new.", pointsAtBrush: true, needsText: false },
  { id: "add", label: "Add", title: "Brush where it goes if it matters, and say what to add", text: "Add: ", pointsAtBrush: false, needsText: true },
  { id: "replace", label: "Replace", title: "Brush an area and say what goes there, or write both", text: "Replace it with: ", pointsAtBrush: true, needsText: true },
  { id: "fix", label: "Fix", title: "Repair damage such as scratches, stains and tears", text: "Repair any damage such as scratches, stains, tears and creases. Keep the people and details as they are.", pointsAtBrush: false, needsText: false },
  { id: "unblur", label: "Unblur", title: "Sharpen a blurry photo. The service may invent detail", text: "Make this sharper and remove the blur. Keep faces and details as they are.", pointsAtBrush: false, needsText: false },
  { id: "enhance", label: "Enhance", title: "Better light and colour", text: "Improve the light, colour and clarity so it looks natural. Do not change what is in the picture.", pointsAtBrush: false, needsText: false },
  { id: "free", label: "Custom", title: "Write your own instruction", text: "", pointsAtBrush: false, needsText: true },
];

export class EditPrompt {
  static preset(id: EditPresetId): EditPreset {
    return EDIT_PRESETS.find((p) => p.id === id)!;
  }

  /** What the user pastes into the service. */
  static compose(text: string, brushed: boolean): string {
    const ask = text.trim();
    if (!brushed) return `Edit the attached photo. ${ask} Return the whole picture with the same framing and shape.`;
    return `Edit the attached photo. The area tinted magenta shows where to work. ${ask} Change only that area and leave everything else exactly as it is. Return the whole picture with the same framing and shape, without any magenta.`;
  }

  /** Whether this button's text still says "it" with nothing to point at. */
  static needsTarget(preset: EditPreset, text: string, strokes: number): boolean {
    return preset.pointsAtBrush && strokes === 0 && text.trim() === preset.text.trim();
  }

  /** Whether this button can be sent as it stands. */
  static ready(preset: EditPreset, text: string, strokes: number): boolean {
    const typed = text.trim();
    if (typed === "" || EditPrompt.needsTarget(preset, text, strokes)) return false;
    return !preset.needsText || typed !== preset.text.trim();
  }
}
