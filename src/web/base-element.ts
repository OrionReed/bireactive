import { Cell, effect, isCell, Writable } from "../core";

export function css(strings: TemplateStringsArray, ...values: any[]) {
  const styles = new CSSStyleSheet();
  styles.replaceSync(String.raw(strings, ...values));
  return styles;
}

export interface ComplexAttributeConverter<Type = unknown, TypeHint = unknown> {
  /**
   * Called to convert an attribute value to a property
   * value.
   */
  fromAttribute(value: string | null, type?: TypeHint): Type;

  /**
   * Called to convert a property value to an attribute
   * value.
   *
   * It returns unknown instead of string, to be compatible with
   * https://github.com/WICG/trusted-types (and similar efforts).
   */
  toAttribute(value: Type, type?: TypeHint): unknown;
}

export interface AttrOptions<Type = unknown, TypeHint = unknown> {
  /**
   * Indicates the type of the property. This is used only as a hint for the
   * `converter` to determine how to convert the attribute
   * to/from a property.
   */
  type: TypeHint;
  /**
   * Indicates how to convert the attribute to/from a property. If this value
   * is a function, it is used to convert the attribute value a the property
   * value. If it's an object, it can have keys for `fromAttribute` and
   * `toAttribute`. If no `toAttribute` function is provided and
   * `reflect` is set to `true`, the property value is set directly to the
   * attribute. A default `converter` is used if none is provided; it supports
   * `Boolean`, `String`, `Number`, `Object`, and `Array`. Note,
   * when a property changes and the converter is used to update the attribute,
   * the property is never updated again as a result of the attribute changing,
   * and vice versa.
   */
  converter?: ComplexAttributeConverter<Type, TypeHint>,
   /**
   * Indicates the name of the observed attribute.
   * If absent, the lowercased property name is observed (e.g. `fooBar`
   * becomes `foobar`). If a string, the string value is observed (e.g
   * `attribute: 'foo-bar'`).
   */
  attribute?: string;
  /**
   * Indicates if the property should reflect to an attribute.
   * If `true`, when the property is set, the attribute is set using the
   * attribute name determined according to the rules for the `attribute`
   * property option and the value of the property converted using the rules
   * from the `converter` property option.
   */
  reflect?: boolean;
}

export const defaultConverter: ComplexAttributeConverter = {
  toAttribute(value: unknown, type?: unknown): unknown {
    switch (type) {
      case Boolean:
        value = value ? '' : null;
        break;
      case Object:
      case Array:
        // if the value is `null` or `undefined` pass this through
        // to allow removing/no change behavior.
        value = value == null ? value : JSON.stringify(value);
        break;
    }
    return value;
  },

  fromAttribute(value: string | null, type?: unknown) {
    let fromValue: unknown = value;
    switch (type) {
      case Boolean:
        fromValue = value !== null;
        break;
      case Number:
        fromValue = value === null ? null : Number(value);
        break;
      case Object:
      case Array:
        // Do *not* generate exception when invalid JSON is set as elements
        // don't normally complain on being mis-configured.
        // TODO(sorvell): Do generate exception in *dev mode*.
        try {
          // Assert to adhere to Bazel's "must type assert JSON parse" rule.
          fromValue = JSON.parse(value!) as unknown;
        } catch (e) {
          fromValue = null;
        }
        break;
    }
    return fromValue;
  },
};
 
export function attr(options: AttrOptions) {
  return function (target: BaseElement, propertyKey: string) {
    options.type ??= String;
    options.reflect ??= true;
    options.attribute ??= propertyKey;
    options.converter ??= defaultConverter;
    
    const c = target.constructor as typeof BaseElement;
    c._attributes.set(propertyKey, options as Required<AttrOptions>);
    c._attributeToPropertyName.set(options.attribute, propertyKey);
  };
}

export type Styles = CSSStyleSheet | CSSStyleSheet[];

export class BaseElement extends HTMLElement {
  static _attributes = new Map<string, Required<AttrOptions>>();
  static _attributeToPropertyName = new Map<string, string>()
  
  static styles: Styles = [];

  static get tagName(): string {
    return this.name
      .replace(/([A-Z])/g, "-$1")
      .toLowerCase()
      .slice(1);
  }

  static define(): void {
    customElements.define(this.tagName, this);
  }

  static get observedAttributes(): string[] {
    return Array.from(this._attributeToPropertyName.keys());
  }

  shadow: ShadowRoot;

  #reflecting = false;
  #reflectingCleanup: ReturnType<typeof effect>[] = [];

  constructor() {
    super();

    this.shadow = this.attachShadow({ mode: "open" });
    
    const constructor = this.constructor as typeof BaseElement;
    const styles = constructor.styles;
    if (styles instanceof Array) {
      this.shadow.adoptedStyleSheets.push(...styles);
    }  else {
      this.shadow.adoptedStyleSheets.push(styles);
    }
  }

  connectedCallback() {
    const constructor = this.constructor as typeof BaseElement;

    for (const [name, options] of constructor._attributes.entries()) {
      if (options.reflect) {
        const cell = this[name as keyof BaseElement] as any;
        console.log(cell)
        if (isCell(cell)) {
          const cb = effect(() => {
            // console.log('attr effect', this.#reflecting)
            if (!this.#reflecting) {
              this.#reflecting = true;
              queueMicrotask(() => this.#reflecting = false)
            }
            const str = options.converter.toAttribute(cell.value, options.type);
            // console.log(str)
            this.setAttribute(options.attribute, str as string);
          });
          this.#reflectingCleanup.push(cb);
        }
      }
    }
  }
  
  disconnectedCallback(): void {
    for(const cb of this.#reflectingCleanup) {
      cb();
    }
  }

  attributeChangedCallback(name: string, oldValue: string, newValue: string): void {
    console.log('attr change', this.#reflecting, name, newValue)
    if (this.#reflecting) return;

    if (oldValue !== newValue) {
      const constructor = this.constructor as typeof BaseElement;
      const propertyName = constructor._attributeToPropertyName.get(name)!;
      const attrOptions = constructor._attributes.get(propertyName)!;

      const cell = this[propertyName as keyof BaseElement] as any;
      if (isCell(cell)) {
        const parsedValue = attrOptions.converter.fromAttribute(newValue, attrOptions.type);
        (cell as Writable<Cell>).value = parsedValue;
      }
    }
  }
}