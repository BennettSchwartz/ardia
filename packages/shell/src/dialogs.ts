export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmTitle?: string;
  cancelTitle?: string;
  destructive?: boolean;
  suppression?: string;
  windowId?: string;
  onlyIfShown?: boolean;
};

export type PromptOptions = {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  confirmTitle?: string;
  windowId?: string;
};

export type DialogsNative = {
  confirm(options: ConfirmOptions): Promise<{ confirmed: boolean; suppressed: boolean; unshown?: boolean }>;
  prompt(options: PromptOptions): Promise<string | null>;
  pickFiles(): Promise<string[]>;
  pickFolder(current: string | null, prompt: string | null): Promise<string | null>;
};
