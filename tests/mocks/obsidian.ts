export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export class Notice {
  static readonly messages: string[] = [];

  constructor(message: unknown) {
    if (typeof message === "string") Notice.messages.push(message);
  }
}
export class Modal {}
export class PluginSettingTab {
  constructor(..._args: unknown[]) {}
}
export class Setting {}
export class SuggestModal {}
export class TFile {}
export class TFolder {}
