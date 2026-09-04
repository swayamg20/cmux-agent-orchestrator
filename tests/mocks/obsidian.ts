export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export class Notice {
  static readonly messages: string[] = [];

  constructor(message: unknown) {
    if (typeof message === "string") Notice.messages.push(message);
  }
}
export class Modal {
  static readonly instances: Modal[] = [];

  opened = false;
  closeCalls = 0;

  constructor(..._args: unknown[]) {
    Modal.instances.push(this);
  }

  open(): void {
    this.opened = true;
  }

  close(): void {
    this.opened = false;
    this.closeCalls += 1;
    this.onClose();
  }

  onClose(): void {}
}
export class PluginSettingTab {
  constructor(..._args: unknown[]) {}
}
export class Setting {}
export class SuggestModal extends Modal {
  emptyStateText = "";

  setPlaceholder(_placeholder: string): void {}
}
export class TFile {}
export class TFolder {}
