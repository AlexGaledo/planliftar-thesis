/**
 * JSX typing for the <model-viewer> custom element (registered at runtime by
 * a dynamic import of "@google/model-viewer"). Attributes are passed as plain
 * strings, which is how React 18 forwards props to custom elements.
 */
import type { DetailedHTMLProps, HTMLAttributes } from "react";

interface ModelViewerAttributes extends HTMLAttributes<HTMLElement> {
  src?: string;
  alt?: string;
  ar?: string;
  "ar-modes"?: string;
  "ar-scale"?: string;
  "ios-src"?: string;
  "camera-controls"?: string;
  "touch-action"?: string;
  "shadow-intensity"?: string;
  class?: string;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": DetailedHTMLProps<ModelViewerAttributes, HTMLElement>;
    }
  }
}
