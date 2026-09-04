export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export class Notice {
  static readonly messages: string[] = [];

  constructor(message: unknown) {
    if (typeof message === "string") Notice.messages.push(message);
  }
}

class MockElement {
  readonly children: MockElement[] = [];
  readonly classes = new Set<string>();
  text = "";

  addClass(...classes: string[]): void {
    for (const className of classes) this.classes.add(className);
  }

  empty(): void {
    this.children.length = 0;
    this.text = "";
  }

  setText(value: string): void {
    this.text = value;
  }

  createEl(_tag: string, options: { cls?: string; text?: string } = {}): MockElement {
    return this.createChild(options);
  }

  createDiv(options: { cls?: string; text?: string } = {}): MockElement {
    return this.createChild(options);
  }

  private createChild(options: { cls?: string; text?: string }): MockElement {
    const child = new MockElement();
    if (options.cls) child.addClass(options.cls);
    if (options.text) child.setText(options.text);
    this.children.push(child);
    return child;
  }
}

export class Modal {
  static readonly instances: Modal[] = [];

  readonly contentEl = new MockElement();
  readonly titleEl = new MockElement();
  opened = false;
  closeCalls = 0;

  constructor(..._args: unknown[]) {
    Modal.instances.push(this);
  }

  open(): void {
    this.opened = true;
    this.onOpen();
  }

  close(): void {
    this.opened = false;
    this.closeCalls += 1;
    this.onClose();
  }

  onOpen(): void {}
  onClose(): void {}
}
export class PluginSettingTab {
  constructor(..._args: unknown[]) {}
}

export class TextComponent {
  readonly inputEl = {
    focusCalls: 0,
    focus: (): void => {
      this.inputEl.focusCalls += 1;
    }
  };
  value = "";
  placeholder = "";
  change: (value: string) => void = () => undefined;

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  setPlaceholder(value: string): this {
    this.placeholder = value;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.change = callback;
    return this;
  }
}

export class DropdownComponent {
  options: Record<string, string> = {};
  value = "";
  change: (value: string) => void = () => undefined;

  addOptions(options: Record<string, string>): this {
    this.options = { ...this.options, ...options };
    return this;
  }

  setValue(value: string): this {
    this.value = value;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.change = callback;
    return this;
  }
}

export class ToggleComponent {
  value = false;
  change: (value: boolean) => void = () => undefined;

  setValue(value: boolean): this {
    this.value = value;
    return this;
  }

  onChange(callback: (value: boolean) => void): this {
    this.change = callback;
    return this;
  }
}

export class ButtonComponent {
  readonly buttonEl = new MockElement();
  disabled = false;
  disabledValues: boolean[] = [];
  text = "";
  click: () => void = () => undefined;

  setButtonText(value: string): this {
    this.text = value;
    return this;
  }

  setCta(): this {
    return this;
  }

  setWarning(): this {
    return this;
  }

  setDestructive(): this {
    return this;
  }

  setDisabled(value: boolean): this {
    this.disabled = value;
    this.disabledValues.push(value);
    return this;
  }

  onClick(callback: () => void): this {
    this.click = callback;
    return this;
  }
}

export class Setting {
  static readonly instances: Setting[] = [];

  readonly buttons: ButtonComponent[] = [];
  readonly dropdowns: DropdownComponent[] = [];
  readonly texts: TextComponent[] = [];
  readonly toggles: ToggleComponent[] = [];
  name = "";
  description = "";

  constructor(..._args: unknown[]) {
    Setting.instances.push(this);
  }

  setName(value: string): this {
    this.name = value;
    return this;
  }

  setDesc(value: string): this {
    this.description = value;
    return this;
  }

  setHeading(): this {
    return this;
  }

  addText(build: (component: TextComponent) => void): this {
    const component = new TextComponent();
    this.texts.push(component);
    build(component);
    return this;
  }

  addDropdown(build: (component: DropdownComponent) => void): this {
    const component = new DropdownComponent();
    this.dropdowns.push(component);
    build(component);
    return this;
  }

  addToggle(build: (component: ToggleComponent) => void): this {
    const component = new ToggleComponent();
    this.toggles.push(component);
    build(component);
    return this;
  }

  addButton(build: (component: ButtonComponent) => void): this {
    const component = new ButtonComponent();
    this.buttons.push(component);
    build(component);
    return this;
  }
}
export class SuggestModal extends Modal {
  emptyStateText = "";

  setPlaceholder(_placeholder: string): void {}
}
export class TFile {}
export class TFolder {}
