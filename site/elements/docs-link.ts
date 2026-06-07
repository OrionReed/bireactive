import { BaseElement, css } from "./base-element";

const DOCS_URL = "https://orionreed.github.io/bireactive/api/";

export class DocsLink extends BaseElement {
  static styles = css`
    :host {
      display: block;
      position: fixed;
      top: calc(2rem + 2 * (40px + 0.25rem));
      right: 2rem;
      z-index: 1000;
    }

    .link {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: opacity 0.3s ease;
      opacity: 0.6;
    }

    .link:hover {
      opacity: 1;
    }

    .icon {
      width: 20px;
      height: 20px;
      stroke: var(--text-color, #24292e);
      fill: none;
      transition: stroke 0.3s ease;
    }

    @media (max-width: 600px) {
      :host {
        top: calc(1rem + 2 * (36px + 0.25rem));
        right: 1rem;
      }

      .link {
        width: 36px;
        height: 36px;
      }
    }
  `;

  protected render(): void {
    this.shadow.innerHTML = `
      <a class="link" href="${DOCS_URL}" target="_blank" rel="noopener noreferrer" aria-label="API documentation">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path>
        </svg>
      </a>
    `;
  }
}
