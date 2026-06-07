export class BaseElement extends HTMLElement {
  protected shadow: ShadowRoot;
  private static styleSheets = new Map<string, CSSStyleSheet>();
  static styles?: string;
  static _attributes?: string[];

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    this.initializeStyles();
  }

  connectedCallback(): void {
    this.render();
  }

  static get tagName(): string {
    return this.name
      .replace(/([A-Z])/g, "-$1")
      .toLowerCase()
      .slice(1);
  }

  static get observedAttributes(): string[] {
    return this._attributes || [];
  }

  static define(): void {
    customElements.define(this.tagName, this);
  }

  private initializeStyles(): void {
    const constructor = this.constructor as typeof BaseElement;
    const className = constructor.name;

    if (!BaseElement.styleSheets.has(className)) {
      // Base first, subclass last — cascade lets subclasses override.
      const chain: string[] = [];
      let proto: any = constructor;
      while (proto && proto !== HTMLElement && proto !== Object) {
        if (Object.prototype.hasOwnProperty.call(proto, "styles") && proto.styles) {
          chain.unshift(proto.styles);
        }
        proto = Object.getPrototypeOf(proto);
      }
      if (chain.length > 0) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(chain.join("\n"));
        BaseElement.styleSheets.set(className, sheet);
      }
    }

    const styleSheet = BaseElement.styleSheets.get(className);
    if (styleSheet) {
      this.shadow.adoptedStyleSheets = [styleSheet];
    }
  }

  attributeChangedCallback(_name: string, oldValue: string, newValue: string): void {
    if (oldValue !== newValue) {
      this.render();
    }
  }

  protected render(): void {}
}

export const css = String.raw;
