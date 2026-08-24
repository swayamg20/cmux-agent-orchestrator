export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export class Notice {}
export class Modal {}
export class Setting {}
export class SuggestModal {}
export class TFile {}
export class TFolder {}
