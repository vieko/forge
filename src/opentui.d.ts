// Ambient declarations for @opentui packages.
// The @opentui packages use bundler-style imports (no .js extensions) in their
// .d.ts files, which are incompatible with TypeScript's NodeNext resolution.
// Declare the subset we use as ambient modules.

import type { ReactNode, Key } from "react";

declare module "bun:ffi" {
  type Pointer = number;
  export { Pointer };
}

declare module "@opentui/core" {
  export interface CliRendererConfig {
    exitOnCtrlC?: boolean;
    [key: string]: unknown;
  }

  export interface CliRenderer {
    [key: string]: unknown;
  }

  export interface KeyEvent {
    name: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    eventType?: "press" | "release" | "repeat";
    repeated?: boolean;
  }

  export interface ScrollBoxChild {
    id?: string;
    y: number;
    height: number;
    [key: string]: unknown;
  }

  export interface ScrollBoxRenderable {
    y: number;
    height: number;
    scrollTop: number;
    scrollHeight: number;
    scrollBy(delta: number): void;
    scrollTo(position: number): void;
    getChildren(): ScrollBoxChild[];
    [key: string]: unknown;
  }

  export function createCliRenderer(config?: CliRendererConfig): Promise<CliRenderer>;
}

declare module "@opentui/react" {
  import type { CliRenderer, KeyEvent } from "@opentui/core";

  export interface Root {
    render: (node: ReactNode) => void;
    unmount: () => void;
  }

  export function createRoot(renderer: CliRenderer): Root;

  export function useKeyboard(
    handler: (key: KeyEvent) => void,
    options?: { release?: boolean },
  ): void;

  export function useRenderer(): CliRenderer;

  export function useTerminalDimensions(): { width: number; height: number };

  export function useOnResize(callback: (width: number, height: number) => void): void;

  export function extend(components: Record<string, unknown>): void;
}

// Style properties for OpenTUI components
interface OpenTUIStyleObject {
  backgroundColor?: string;
  padding?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  margin?: number;
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
  width?: number | string;
  height?: number | string;
  flexDirection?: "row" | "column";
  flexGrow?: number;
  gap?: number;
  border?: boolean;
  borderStyle?: string;
  borderColor?: string;
  alignItems?: string;
  justifyContent?: string;
  [key: string]: unknown;
}

interface OpenTUIBoxProps {
  key?: Key;
  id?: string;
  children?: ReactNode;
  title?: string;
  border?: boolean;
  borderStyle?: string;
  borderColor?: string;
  flexDirection?: "row" | "column";
  flexGrow?: number;
  focused?: boolean;
  backgroundColor?: string;
  padding?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  style?: OpenTUIStyleObject;
  [key: string]: unknown;
}

interface OpenTUITextProps {
  key?: Key;
  children?: ReactNode;
  content?: string;
  fg?: string;
  bg?: string;
  style?: OpenTUIStyleObject & { fg?: string; bg?: string };
  [key: string]: unknown;
}

interface OpenTUISpanProps {
  key?: Key;
  children?: ReactNode;
  fg?: string;
  bg?: string;
  [key: string]: unknown;
}

interface OpenTUIScrollBoxProps {
  key?: Key;
  children?: ReactNode;
  focused?: boolean;
  ref?: (r: any) => void;
  style?: OpenTUIStyleObject;
  [key: string]: unknown;
}

declare module "@opentui/react/jsx-runtime" {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;

  export namespace JSX {
    type Element = ReactNode;
    interface IntrinsicElements {
      box: OpenTUIBoxProps;
      text: OpenTUITextProps;
      span: OpenTUISpanProps;
      scrollbox: OpenTUIScrollBoxProps;
      strong: OpenTUISpanProps;
      em: OpenTUISpanProps;
      u: OpenTUISpanProps;
      b: OpenTUISpanProps;
      i: OpenTUISpanProps;
      br: Record<string, unknown>;
    }
  }
}
