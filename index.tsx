/**
 * @fileoverview Control real time music with text prompts
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {css, CSSResultGroup, html, LitElement, svg} from 'lit';
import {customElement, property, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {styleMap} from 'lit/directives/style-map.js';

import {
  GoogleGenAI,
  type LiveMusicGenerationConfig,
  type LiveMusicServerMessage,
  type LiveMusicSession,
  // Fix: Import MusicGenerationMode and Scale enums for strong typing.
  MusicGenerationMode,
  Scale,
} from '@google/genai';
import {decode, decodeAudioData} from './utils';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});
let model = 'lyria-realtime-exp';

interface Prompt {
  readonly promptId: string;
  readonly color: string;
  text: string;
  weight: number;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

/** Throttles a callback to be called at most once per `freq` milliseconds. */
function throttle(func: (...args: unknown[]) => void, delay: number) {
  let lastCall = 0;
  return (...args: unknown[]) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delay) {
      func(...args);
      lastCall = now;
    }
  };
}

const PROMPT_TEXT_PRESETS = [
  'Ambient',
  'Minimal Techno kick',
  'Percussions',
  'Synthetizer Melody',
];

const COLORS = [
  '#9900ff',
  '#5200ff',
  '#ff25f6',
  '#2af6de',
  '#ffdd28',
  '#3dffab',
  '#d8ff3e',
  '#d9b2ff',
];

function getUnusedRandomColor(usedColors: string[]): string {
  const availableColors = COLORS.filter((c) => !usedColors.includes(c));
  if (availableColors.length === 0) {
    // If no available colors, pick a random one from the original list.
    return COLORS[Math.floor(Math.random() * COLORS.length)];
  }
  return availableColors[Math.floor(Math.random() * availableColors.length)];
}

// WeightSlider component
// -----------------------------------------------------------------------------
/** A slider for adjusting and visualizing prompt weight. */
@customElement('weight-slider')
// Fix: Extend LitElement to make this a valid web component and fix override/property errors.
class WeightSlider extends LitElement {
  static override styles = css`
    :host {
      cursor: ns-resize;
      position: relative;
      height: 100%;
      display: flex;
      justify-content: center;
      flex-direction: column;
      align-items: center;
      padding: 5px;
    }
    .scroll-container {
      width: 100%;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    .value-display {
      font-size: 1.3vmin;
      color: #ccc;
      margin: 0.5vmin 0;
      user-select: none;
      text-align: center;
    }
    .slider-container {
      position: relative;
      width: 10px;
      height: 100%;
      background-color: #0009;
      border-radius: 4px;
    }
    #thumb {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      border-radius: 4px;
      box-shadow: 0 0 3px rgba(0, 0, 0, 0.7);
    }
  `;

  @property({type: Number}) value = 0; // Range 0-2
  @property({type: String}) color = '#000';

  @query('.scroll-container') private scrollContainer!: HTMLDivElement;

  private dragStartPos = 0;
  private dragStartValue = 0;
  private containerBounds: DOMRect | null = null;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    this.containerBounds = this.scrollContainer.getBoundingClientRect();
    this.dragStartPos = e.clientY;
    this.dragStartValue = this.value;
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('touchmove', this.handleTouchMove, {
      passive: false,
    });
    window.addEventListener('pointerup', this.handlePointerUp, {once: true});
    this.updateValueFromPosition(e.clientY);
  }

  private handlePointerMove(e: PointerEvent) {
    this.updateValueFromPosition(e.clientY);
  }

  private handleTouchMove(e: TouchEvent) {
    e.preventDefault();
    this.updateValueFromPosition(e.touches[0].clientY);
  }

  private handlePointerUp(e: PointerEvent) {
    window.removeEventListener('pointermove', this.handlePointerMove);
    document.body.classList.remove('dragging');
    this.containerBounds = null;
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY;
    this.value = this.value + delta * -0.005;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchInputEvent();
  }

  private updateValueFromPosition(clientY: number) {
    if (!this.containerBounds) return;

    const trackHeight = this.containerBounds.height;
    // Calculate position relative to the top of the track
    const relativeY = clientY - this.containerBounds.top;
    // Invert and normalize (0 at bottom, 1 at top)
    const normalizedValue =
      1 - Math.max(0, Math.min(trackHeight, relativeY)) / trackHeight;
    // Scale to 0-2 range
    this.value = normalizedValue * 2;

    this.dispatchInputEvent();
  }

  private dispatchInputEvent() {
    this.dispatchEvent(new CustomEvent<number>('input', {detail: this.value}));
  }

  override render() {
    const thumbHeightPercent = (this.value / 2) * 100;
    const thumbStyle = styleMap({
      height: `${thumbHeightPercent}%`,
      backgroundColor: this.color,
      // Hide thumb if value is 0 or very close to prevent visual glitch
      display: this.value > 0.01 ? 'block' : 'none',
    });
    const displayValue = this.value.toFixed(2);

    return html`
      <div
        class="scroll-container"
        @pointerdown=${this.handlePointerDown}
        @wheel=${this.handleWheel}>
        <div class="slider-container">
          <div id="thumb" style=${thumbStyle}></div>
        </div>
        <div class="value-display">${displayValue}</div>
      </div>
    `;
  }
}

// Base class for icon buttons.
// Fix: Extend LitElement to make this a valid web component and fix override/property errors.
class IconButton extends LitElement {
  static override styles = css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    :host(:hover) svg {
      transform: scale(1.2);
    }
    svg {
      width: 100%;
      height: 100%;
      transition: transform 0.5s cubic-bezier(0.25, 1.56, 0.32, 0.99);
    }
    .hitbox {
      pointer-events: all;
      position: absolute;
      width: 65%;
      aspect-ratio: 1;
      top: 9%;
      border-radius: 50%;
      cursor: pointer;
    }
  ` as CSSResultGroup;

  // Method to be implemented by subclasses to provide the specific icon SVG
  protected renderIcon() {
    return svg``; // Default empty icon
  }

  private renderSVG() {
    return html` <svg
      width="140"
      height="140"
      viewBox="0 -10 140 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg">
      <rect
        x="22"
        y="6"
        width="96"
        height="96"
        rx="48"
        fill="black"
        fill-opacity="0.05" />
      <rect
        x="23.5"
        y="7.5"
        width="93"
        height="93"
        rx="46.5"
        stroke="black"
        stroke-opacity="0.3"
        stroke-width="3" />
      <g filter="url(#filter0_ddi_1048_7373)">
        <rect
          x="25"
          y="9"
          width="90"
          height="90"
          rx="45"
          fill="white"
          fill-opacity="0.05"
          shape-rendering="crispEdges" />
      </g>
      ${this.renderIcon()}
      <defs>
        <filter
          id="filter0_ddi_1048_7373"
          x="0"
          y="0"
          width="140"
          height="140"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="4" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow_1048_7373" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="16" />
          <feGaussianBlur stdDeviation="12.5" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="effect1_dropShadow_1048_7373"
            result="effect2_dropShadow_1048_7373" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect2_dropShadow_1048_7373"
            result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="3" />
          <feGaussianBlur stdDeviation="1.5" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.05 0" />
          <feBlend
            mode="normal"
            in2="shape"
            result="effect3_innerShadow_1048_7373" />
        </filter>
      </defs>
    </svg>`;
  }

  override render() {
    return html`${this.renderSVG()}<div class="hitbox"></div>`;
  }
}

// PlayPauseButton
// -----------------------------------------------------------------------------

/** A button for toggling play/pause. */
@customElement('play-pause-button')
export class PlayPauseButton extends IconButton {
  @property({type: String}) playbackState: PlaybackState = 'stopped';

  static override styles = [
    IconButton.styles,
    css`
      .loader {
        stroke: #ffffff;
        stroke-width: 3;
        stroke-linecap: round;
        animation: spin linear 1s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(359deg);
        }
      }
    `,
  ];

  private renderPause() {
    return svg`<path
      d="M75.0037 69V39H83.7537V69H75.0037ZM56.2537 69V39H65.0037V69H56.2537Z"
      fill="#FEFEFE"
    />`;
  }

  private renderPlay() {
    return svg`<path d="M60 71.5V36.5L87.5 54L60 71.5Z" fill="#FEFEFE" />`;
  }

  private renderLoading() {
    return svg`<path shape-rendering="crispEdges" class="loader" d="M70,74.2L70,74.2c-10.7,0-19.5-8.7-19.5-19.5l0,0c0-10.7,8.7-19.5,19.5-19.5
            l0,0c10.7,0,19.5,8.7,19.5,19.5l0,0"/>`;
  }

  override renderIcon() {
    if (this.playbackState === 'playing') {
      return this.renderPause();
    } else if (this.playbackState === 'loading') {
      return this.renderLoading();
    } else {
      return this.renderPlay();
    }
  }
}

@customElement('reset-button')
export class ResetButton extends IconButton {
  private renderResetIcon() {
    return svg`<path fill="#fefefe" d="M71,77.1c-2.9,0-5.7-0.6-8.3-1.7s-4.8-2.6-6.7-4.5c-1.9-1.9-3.4-4.1-4.5-6.7c-1.1-2.6-1.7-5.3-1.7-8.3h4.7
      c0,4.6,1.6,8.5,4.8,11.7s7.1,4.8,11.7,4.8c4.6,0,8.5-1.6,11.7-4.8c3.2-3.2,4.8-7.1,4.8-11.7s-1.6-8.5-4.8-11.7
      c-3.2-3.2-7.1-4.8-11.7-4.8h-0.4l3.7,3.7L71,46.4L61.5,37l9.4-9.4l3.3,3.4l-3.7,3.7H71c2.9,0,5.7,0.6,8.3,1.7
      c2.6,1.1,4.8,2.6,6.7,4.5c1.9,1.9,3.4,4.1,4.5,6.7c1.1,2.6,1.7,5.3,1.7,8.3c0,2.9-0.6,5.7-1.7,8.3c-1.1,2.6-2.6,4.8-4.5,6.7
      s-4.1,3.4-6.7,4.5C76.7,76.5,73.9,77.1,71,77.1z"/>`;
  }

  override renderIcon() {
    return this.renderResetIcon();
  }
}

// AddPromptButton component
// -----------------------------------------------------------------------------
/** A button for adding a new prompt. */
@customElement('add-prompt-button')
export class AddPromptButton extends IconButton {
  private renderAddIcon() {
    return svg`<path d="M67 40 H73 V52 H85 V58 H73 V70 H67 V58 H55 V52 H67 Z" fill="#FEFEFE" />`;
  }

  override renderIcon() {
    return this.renderAddIcon();
  }
}

/** A button for opening the settings modal. */
@customElement('settings-button')
export class SettingsButton extends IconButton {
  private renderSettingsIcon() {
    return svg`<path d="M77.1,70.9l-4.3-1.8c-0.6-0.3-1.3-0.4-1.9-0.4c-0.7,0-1.4,0.1-2,0.4l-4.3,1.8c-2,0.8-4.2-0.6-4.2-2.7v-4.7
	c0-0.6-0.1-1.3-0.4-1.9c-0.3-0.6-0.6-1.2-1-1.7l-3.3-3.3c-1.5-1.5-0.9-4.2,1.3-4.9l4.5-1.5c0.6-0.2,1.2-0.6,1.7-1
	c0.5-0.4,0.8-1,1-1.7l1.5-4.5c0.7-2.1,3.4-2.1,4.2,0l1.5,4.5c0.2,0.6,0.6,1.2,1,1.7c0.4,0.5,1,0.8,1.7,1l4.5,1.5
	c2.1,0.7,2.8,3.4,1.3,4.9l-3.3,3.3c-0.4,0.5-0.8,1-1,1.7c-0.3,0.6-0.4,1.3-0.4,1.9v4.7C81.3,70.3,79.1,71.7,77.1,70.9z M70,59.3
	c-4.6,0-8.3-3.7-8.3-8.3s3.7-8.3,8.3-8.3s8.3,3.7,8.3,8.3S74.6,59.3,70,59.3z" fill="#FEFEFE"/>`;
  }
  override renderIcon() {
    return this.renderSettingsIcon();
  }
}

// Toast Message component
// -----------------------------------------------------------------------------

@customElement('toast-message')
// Fix: Extend LitElement to make this a valid web component and fix override/property errors.
class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      line-height: 1.6;
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #000;
      color: white;
      padding: 15px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      min-width: 200px;
      max-width: 80vw;
      transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1);
      z-index: 1001;
    }
    button {
      border-radius: 100px;
      aspect-ratio: 1;
      border: none;
      color: #000;
      cursor: pointer;
    }
    .toast:not(.showing) {
      transition-duration: 1s;
      transform: translate(-50%, -200%);
    }
  `;

  @property({type: String}) message = '';
  @property({type: Boolean}) showing = false;

  override render() {
    return html`<div class=${classMap({showing: this.showing, toast: true})}>
      <div class="message">${this.message}</div>
      <button @click=${this.hide}>✕</button>
    </div>`;
  }

  show(message: string) {
    this.showing = true;
    this.message = message;
  }

  hide() {
    this.showing = false;
  }
}

/** A custom horizontal slider component */
@customElement('horizontal-slider')
// Fix: Extend LitElement to make this a valid web component and fix override/property errors.
class HorizontalSlider extends LitElement {
  static override styles = css`
    :host {
      cursor: ew-resize;
      position: relative;
      width: 100%;
      height: 16px; /* thumb height */
      display: flex;
      align-items: center;
      margin: 0.5vmin 0;
      -webkit-tap-highlight-color: transparent; /* Disable tap highlight on mobile */
    }
    .slider-container {
      position: relative;
      width: 100%;
      height: 8px; /* track height */
      background-color: #0009;
      border-radius: 4px;
      display: flex;
      align-items: center;
    }
    .track-progress {
      position: absolute;
      left: 0;
      top: 0;
      height: 100%;
      background-color: #5200ff;
      border-radius: 4px;
      pointer-events: none;
    }
    #thumb {
      position: absolute;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 16px;
      height: 16px;
      background-color: #5200ff;
      border-radius: 50%;
      box-shadow: 0 0 3px rgba(0, 0, 0, 0.7);
      pointer-events: none;
    }
  `;

  @property({type: Number}) value = 0;
  @property({type: Number}) min = 0;
  @property({type: Number}) max = 1;
  @property({type: Number}) step = 0.1;
  @property({type: String}) id = '';

  @query('.slider-container') private sliderContainer!: HTMLDivElement;

  private containerBounds: DOMRect | null = null;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    this.sliderContainer.setPointerCapture(e.pointerId);
    this.containerBounds = this.sliderContainer.getBoundingClientRect();
    document.body.classList.add('dragging');
    this.sliderContainer.addEventListener('pointermove', this.handlePointerMove);
    this.sliderContainer.addEventListener('pointerup', this.handlePointerUp, {
      once: true,
    });
    this.updateValueFromPosition(e.clientX);
  }

  private handlePointerMove(e: PointerEvent) {
    this.updateValueFromPosition(e.clientX);
  }

  private handlePointerUp(e: PointerEvent) {
    this.sliderContainer.releasePointerCapture(e.pointerId);
    this.sliderContainer.removeEventListener(
      'pointermove',
      this.handlePointerMove,
    );
    document.body.classList.remove('dragging');
    this.containerBounds = null;
  }

  private updateValueFromPosition(clientX: number) {
    if (!this.containerBounds) return;

    const trackWidth = this.containerBounds.width;
    const relativeX = clientX - this.containerBounds.left;
    const normalizedValue =
      Math.max(0, Math.min(trackWidth, relativeX)) / trackWidth;

    let rawValue = this.min + normalizedValue * (this.max - this.min);

    if (this.step > 0) {
      rawValue = Math.round(rawValue / this.step) * this.step;
    }

    const newValue = Math.max(this.min, Math.min(this.max, rawValue));

    if (this.value !== newValue) {
      this.value = newValue;
      this.dispatchInputEvent();
    }
  }

  private dispatchInputEvent() {
    this.dispatchEvent(
      new CustomEvent('value-change', {
        detail: {value: this.value, id: this.id},
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const valuePercent =
      this.max > this.min
        ? ((this.value - this.min) / (this.max - this.min)) * 100
        : 0;
    const progressStyle = styleMap({
      width: `${valuePercent}%`,
    });
    const thumbStyle = styleMap({
      left: `${valuePercent}%`,
    });

    return html`
      <div class="slider-container" @pointerdown=${this.handlePointerDown}>
        <div class="track-progress" style=${progressStyle}></div>
        <div id="thumb" style=${thumbStyle}></div>
      </div>
    `;
  }
}

/** A panel for managing real-time music generation settings. */
@customElement('settings-controller')
// Fix: Extend LitElement to make this a valid web component and fix override/property errors.
class SettingsController extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 2vmin;
      background-color: #2a2a2a;
      color: #eee;
      box-sizing: border-box;
      border-radius: 5px;
      font-family: 'Google Sans', sans-serif;
      font-size: 1.5vmin;
      scrollbar-width: thin;
      scrollbar-color: #666 #1a1a1a;
    }
    :host::-webkit-scrollbar {
      width: 6px;
    }
    :host::-webkit-scrollbar-track {
      background: #1a1a1a;
      border-radius: 3px;
    }
    :host::-webkit-scrollbar-thumb {
      background-color: #666;
      border-radius: 3px;
    }
    .setting {
      margin-bottom: 0.5vmin;
      display: flex;
      flex-direction: column;
      gap: 0.5vmin;
    }
    label {
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
      white-space: nowrap;
      user-select: none;
    }
    label span:last-child {
      font-weight: normal;
      color: #ccc;
      min-width: 3em;
      text-align: right;
    }
    input[type='number'],
    input[type='text'],
    select {
      background-color: #2a2a2a;
      color: #eee;
      border: 1px solid #666;
      border-radius: 3px;
      padding: 0.4vmin;
      font-size: 1.5vmin;
      font-family: inherit;
      box-sizing: border-box;
    }
    input[type='number'] {
      width: 6em;
    }
    input[type='text'] {
      width: 100%;
    }
    input[type='text']::placeholder {
      color: #888;
    }
    input[type='number']:focus,
    input[type='text']:focus {
      outline: none;
      border-color: #5200ff;
      box-shadow: 0 0 0 2px rgba(82, 0, 255, 0.3);
    }
    select {
      width: 100%;
    }
    select:focus {
      outline: none;
      border-color: #5200ff;
    }
    select option {
      background-color: #2a2a2a;
      color: #eee;
    }
    .checkbox-setting {
      flex-direction: row;
      align-items: center;
      gap: 1vmin;
    }
    input[type='checkbox'] {
      cursor: pointer;
      accent-color: #5200ff;
    }
    .core-settings-row {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 4vmin;
      margin-bottom: 1vmin;
      justify-content: space-evenly;
    }
    .core-settings-row .setting {
      min-width: 16vmin;
    }
    .core-settings-row label span:last-child {
      min-width: 2.5em;
    }
    .advanced-settings {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10vmin, 1fr));
      gap: 3vmin;
      overflow: hidden;
      max-width: 120vmin;
    }
    hr.divider {
      border: none;
      border-top: 1px solid #666;
      margin: 2vmin 0;
      width: 100%;
    }
    .auto-row {
      display: flex;
      align-items: center;
      gap: 0.5vmin;
    }
    .setting[auto='true'] horizontal-slider {
      pointer-events: none;
      filter: grayscale(100%);
    }
    .auto-row span {
      margin-left: auto;
    }
    .auto-row label {
      cursor: pointer;
    }
    .auto-row input[type='checkbox'] {
      cursor: pointer;
      margin: 0;
    }
  `;

  /**
   * Mahdollistaa ulkoisen päivityksen (esim. HR/Kinect).
   */
  public updateConfig(newConfig: any) {
    this.config = {...this.config, ...newConfig};
    this.requestUpdate(); // pakottaa UI:n päivittymään
  }


  // Fix: Use the MusicGenerationMode enum to fix type error.
  private readonly defaultConfig: LiveMusicGenerationConfig = {
    temperature: 1.1,
    topK: 40,
    guidance: 4.0,
    musicGenerationMode: MusicGenerationMode.QUALITY,
  };

  @state() private config: LiveMusicGenerationConfig = this.defaultConfig;

  @state() private autoDensity = true;
  @state() private lastDefinedDensity: number;
  @state() private autoBrightness = true;
  @state() private lastDefinedBrightness: number;

  constructor() {
    super();
    this.config = {...this.defaultConfig};
  }

  public getConfig(): LiveMusicGenerationConfig {
    return this.config;
  }

  public resetToDefaults() {
    this.config = {...this.defaultConfig};
    this.autoDensity = true;
    this.lastDefinedDensity = undefined;
    this.autoBrightness = true;
    this.lastDefinedBrightness = undefined;
    this.dispatchSettingsChange();
  }

  private handleSettingChange(e: Event | CustomEvent) {
    let key: string;
    let value: any;

    if (e instanceof CustomEvent) {
      // From custom horizontal-slider
      key = e.detail.id;
      value = e.detail.value;
    } else {
      // From native elements
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      key = target.id;
      value = target.value;

      if (target.type === 'number') {
        value = target.value === '' ? undefined : Number(target.value);
      } else if (target.type === 'checkbox') {
        value = (target as HTMLInputElement).checked;
      } else if (target.type === 'select-one') {
        const selectElement = target as HTMLSelectElement;
        if (selectElement.options[selectElement.selectedIndex]?.disabled) {
          value = undefined;
        }
      }
    }

    const newConfig = {...this.config};

    if (key === 'auto-density') {
      this.autoDensity = Boolean(value);
      newConfig.density = this.autoDensity
        ? undefined
        : this.lastDefinedDensity;
    } else if (key === 'auto-brightness') {
      this.autoBrightness = Boolean(value);
      newConfig.brightness = this.autoBrightness
        ? undefined
        : this.lastDefinedBrightness;
    } else if (key === 'musicGenerationMode') {
      newConfig.musicGenerationMode = value as MusicGenerationMode;
    } else if (key === 'scale') {
      newConfig.scale = value as Scale;
    } else {
      (newConfig as any)[key] = value;
    }

    if (newConfig.density !== undefined) {
      this.lastDefinedDensity = newConfig.density;
    }
    if (newConfig.brightness !== undefined) {
      this.lastDefinedBrightness = newConfig.brightness;
    }

    this.config = newConfig;
    this.dispatchSettingsChange();
  }

  private dispatchSettingsChange() {
    this.dispatchEvent(
      new CustomEvent<LiveMusicGenerationConfig>('settings-changed', {
        detail: this.config,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const cfg = this.config;
    // Fix: Use MusicGenerationMode enum for map values.
    const musicGenerationModeMap = new Map<string, MusicGenerationMode>([
      ['Quality', MusicGenerationMode.QUALITY],
      ['Diversity', MusicGenerationMode.DIVERSITY],
      ['Vocalization', MusicGenerationMode.VOCALIZATION],
    ]);
    // Fix: Use Scale enum for map values.
    const scaleMap = new Map<string, Scale>([
      ['Auto', Scale.SCALE_UNSPECIFIED],
      ['C Major / A Minor', Scale.C_MAJOR_A_MINOR],
      ['C# Major / A# Minor', Scale.D_FLAT_MAJOR_B_FLAT_MINOR],
      ['D Major / B Minor', Scale.D_MAJOR_B_MINOR],
      ['D# Major / C Minor', Scale.E_FLAT_MAJOR_C_MINOR],
      ['E Major / C# Minor', Scale.E_MAJOR_D_FLAT_MINOR],
      ['F Major / D Minor', Scale.F_MAJOR_D_MINOR],
      ['F# Major / D# Minor', Scale.G_FLAT_MAJOR_E_FLAT_MINOR],
      ['G Major / E Minor', Scale.G_MAJOR_E_MINOR],
      ['G# Major / F Minor', Scale.A_FLAT_MAJOR_F_MINOR],
      ['A Major / F# Minor', Scale.A_MAJOR_G_FLAT_MINOR],
      ['A# Major / G Minor', Scale.B_FLAT_MAJOR_G_MINOR],
      ['B Major / G# Minor', Scale.B_MAJOR_A_FLAT_MINOR],
    ]);

    return html`
      <div class="core-settings-row">
        <div class="setting">
          <label for="temperature"
            >Temperature<span>${cfg.temperature!.toFixed(1)}</span></label
          >
          <horizontal-slider
            id="temperature"
            .min=${0}
            .max=${3}
            .step=${0.1}
            .value=${cfg.temperature!}
            @value-change=${this.handleSettingChange}></horizontal-slider>
        </div>
        <div class="setting">
          <label for="guidance"
            >Guidance<span>${cfg.guidance!.toFixed(1)}</span></label
          >
          <horizontal-slider
            id="guidance"
            .min=${0}
            .max=${6}
            .step=${0.1}
            .value=${cfg.guidance!}
            @value-change=${this.handleSettingChange}></horizontal-slider>
        </div>
        <div class="setting">
          <label for="topK">Top K<span>${cfg.topK}</span></label>
          <horizontal-slider
            id="topK"
            .min=${1}
            .max=${100}
            .step=${1}
            .value=${cfg.topK!}
            @value-change=${this.handleSettingChange}></horizontal-slider>
        </div>
      </div>
      <hr class="divider" />
      <div class="advanced-settings">
        <div class="setting">
          <label for="seed">Seed</label>
          <input
            type="number"
            id="seed"
            .value=${cfg.seed ?? ''}
            @input=${this.handleSettingChange}
            placeholder="Auto" />
        </div>
        <div class="setting">
          <label for="bpm">BPM</label>
          <input
            type="number"
            id="bpm"
            min="60"
            max="180"
            .value=${cfg.bpm ?? ''}
            @input=${this.handleSettingChange}
            placeholder="Auto" />
        </div>
        <div class="setting" auto=${this.autoDensity}>
          <label for="density">Density</label>
          <horizontal-slider
            id="density"
            .min=${0}
            .max=${1}
            .step=${0.05}
            .value=${this.lastDefinedDensity ?? 0.5}
            @value-change=${this.handleSettingChange}></horizontal-slider>
          <div class="auto-row">
            <input
              type="checkbox"
              id="auto-density"
              .checked=${this.autoDensity}
              @input=${this.handleSettingChange} />
            <label for="auto-density">Auto</label>
            <span>${(this.lastDefinedDensity ?? 0.5).toFixed(2)}</span>
          </div>
        </div>
        <div class="setting" auto=${this.autoBrightness}>
          <label for="brightness">Brightness</label>
          <horizontal-slider
            id="brightness"
            .min=${0}
            .max=${1}
            .step=${0.05}
            .value=${this.lastDefinedBrightness ?? 0.5}
            @value-change=${this.handleSettingChange}></horizontal-slider>
          <div class="auto-row">
            <input
              type="checkbox"
              id="auto-brightness"
              .checked=${this.autoBrightness}
              @input=${this.handleSettingChange} />
            <label for="auto-brightness">Auto</label>
            <span>${(this.lastDefinedBrightness ?? 0.5).toFixed(2)}</span>
          </div>
        </div>
        <div class="setting">
          <label for="scale">Scale</label>
          <select
            id="scale"
            .value=${cfg.scale || 'SCALE_UNSPECIFIED'}
            @change=${this.handleSettingChange}>
            <option value="" disabled selected>Select Scale</option>
            ${[...scaleMap.entries()].map(
              ([displayName, enumValue]) =>
                html`<option value=${enumValue}>${displayName}</option>`,
            )}
          </select>
        </div>
        <div class="setting">
          <label for="musicGenerationMode">Music generation mode</label>
          <select
            id="musicGenerationMode"
            .value=${cfg.musicGenerationMode || 'QUALITY'}
            @change=${this.handleSettingChange}>
            ${[...musicGenerationModeMap.entries()].map(
              ([displayName, enumValue]) =>
                html`<option value=${enumValue}>${displayName}</option>`,
            )}
          </select>
        </div>
        <div class="setting">
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="muteBass"
              .checked=${!!cfg.muteBass}
              @change=${this.handleSettingChange} />
            <label for="muteBass" style="font-weight: normal;">Mute Bass</label>
          </div>
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="muteDrums"
              .checked=${!!cfg.muteDrums}
              @change=${this.handleSettingChange} />
            <label for="muteDrums" style="font-weight: normal;"
              >Mute Drums</label
            >
          </div>
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="onlyBassAndDrums"
              .checked=${!!cfg.onlyBassAndDrums}
              @change=${this.handleSettingChange} />
            <label for="onlyBassAndDrums" style="font-weight: normal;"
              >Only Bass & Drums</label
            >
          </div>
        </div>
      </div>
    `;
  }
}


/** A scrolling panel for displaying log messages in the background. */
@customElement('log-panel')
// Fix: Extend LitElement to make this a valid web component and fix override/property errors.
class LogPanel extends LitElement {
  static override styles = css`
    :host {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 0;
      overflow: hidden;
      pointer-events: none;
      font-family: 'Courier New', Courier, monospace;
      font-size: 1,5vmin;
      color: rgba(200, 255, 200, 0.5);
      -webkit-mask-image: linear-gradient(
        to bottom,
        transparent 0%,
        black 10%,
        black 90%,
        transparent 100%
      );
      mask-image: linear-gradient(
        to bottom,
        transparent 0%,
        black 10%,
        black 90%,
        transparent 100%
      );
      /* Align log content to the bottom */
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
    }
    .scroller {
      display: flex;
      flex-direction: column;
      /* Removed scrolling animation */
    }
    .log-entry {
      white-space: nowrap;
      padding: 0.1vmin 0;
    }
  `;

  @state() logs: string[] = [];
  private readonly MAX_LOGS = 50;

  public addLog(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    const newLogs = [...this.logs, `[${timestamp}] ${message}`];
    if (newLogs.length > this.MAX_LOGS) {
      this.logs = newLogs.slice(newLogs.length - this.MAX_LOGS);
    } else {
      this.logs = newLogs;
    }
  }

  override render() {
    const renderLog = (log: string) => html`<div class="log-entry">${log}</div>`;
    return html`
      <div class="scroller">
        ${this.logs.map(renderLog)}
      </div>
    `;
  }
}

/** A modal window for all settings and controls. */
@customElement('controls-modal')
class ControlsModal extends LitElement {
  @property({type: Boolean, reflect: true}) showing = false;
  @property({type: Object}) prompts: Map<string, Prompt> = new Map();
  @property({type: String}) playbackState: PlaybackState = 'stopped';

  static override styles = css`
    :host {
      display: contents;
    }
    .backdrop {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      z-index: 1000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease-in-out;
    }
    :host([showing]) .backdrop {
      opacity: 1;
      pointer-events: auto;
    }
    .modal {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) scale(0.95);
      background-color: #1a1a1a;
      color: #eee;
      border-radius: 10px;
      z-index: 1001;
      display: flex;
      flex-direction: column;
      width: 90vw;
      max-width: 90vmin;
      max-height: 90vh;
      opacity: 0;
      pointer-events: none;
      transition:
        opacity 0.3s ease-in-out,
        transform 0.3s ease-in-out;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    :host([showing]) .modal {
      opacity: 1;
      pointer-events: auto;
      transform: translate(-50%, -50%) scale(1);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1vmin 2vmin;
      border-bottom: 1px solid #333;
      font-size: 2vmin;
      font-weight: bold;
    }
    .modal-header .close-button {
      background: none;
      border: none;
      color: #eee;
      font-size: 3vmin;
      cursor: pointer;
      line-height: 1;
    }
    .modal-content {
      overflow-y: auto;
      padding: 2vmin;
      display: flex;
      flex-direction: column;
      gap: 2vmin;
    }
    .playback-container {
      display: flex;
      justify-content: center;
      align-items: center;
      flex-shrink: 0;
    }
    play-pause-button,
    reset-button,
    add-prompt-button {
      width: 12vmin;
      flex-shrink: 0;
    }
    h3 {
      margin: 1vmin 0;
      font-size: 1.8vmin;
      color: #aaa;
      border-bottom: 1px solid #444;
      padding-bottom: 0.5vmin;
    }
    .prompts-list {
      display: flex;
      flex-direction: column;
      gap: 1.5vmin;
    }
    .prompt-item {
      display: flex;
      align-items: center;
      gap: 1.5vmin;
      background: #2a2a2a;
      padding: 1vmin;
      border-radius: 5px;
    }
    .prompt-item-text {
      flex: 1;
      font-size: 1.5vmin;
    }
    .prompt-item-text[contenteditable] {
      outline: none;
      border: 1px solid transparent;
      border-radius: 3px;
      padding: 0.2vmin;
      margin: -0.2vmin;
    }
    .prompt-item-text[contenteditable]:focus {
      border-color: #5200ff;
      background: #333;
    }
    .prompt-item .weight-slider-container {
      width: 8vmin;
      height: 12vmin;
    }
    .prompt-item .remove-button {
      background: #666;
      color: #fff;
      border: none;
      border-radius: 50%;
      width: 2.8vmin;
      height: 2.8vmin;
      font-size: 1.8vmin;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .prompt-item .remove-button:hover {
      opacity: 0.8;
    }
  `;

  private _closeModal() {
    this.dispatchEvent(new CustomEvent('close-modal'));
  }

  private _handleWeightChange(e: CustomEvent<number>, prompt: Prompt) {
    this.dispatchEvent(
      new CustomEvent<Partial<Prompt>>('prompt-changed', {
        detail: {
          promptId: prompt.promptId,
          weight: e.detail,
        },
      }),
    );
  }

  private _handlePromptRemoved(prompt: Prompt) {
    this.dispatchEvent(
      new CustomEvent<string>('prompt-removed', {
        detail: prompt.promptId,
      }),
    );
  }

  private _handleTextKeyDown(e: KeyboardEvent, prompt: Prompt) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this._updateText(e, prompt);
      (e.target as HTMLElement).blur();
    }
  }

  private _updateText(e: Event, prompt: Prompt) {
    const newText = (e.target as HTMLElement).textContent?.trim();
    if (newText === '' || newText === prompt.text) {
      (e.target as HTMLElement).textContent = prompt.text; // revert if empty or unchanged
      return;
    }
    this.dispatchEvent(
      new CustomEvent<Partial<Prompt>>('prompt-changed', {
        detail: {
          promptId: prompt.promptId,
          text: newText,
        },
      }),
    );
  }

  override render() {
    if (!this.showing) return html``;
    return html`
      <div class="backdrop" @click=${this._closeModal}></div>
      <div class="modal">
        <div class="modal-header">
          <span>Controls</span>
          <button class="close-button" @click=${this._closeModal}>×</button>
        </div>
        <div class="modal-content">
          <div class="playback-container">
            <play-pause-button
              @click=${() => this.dispatchEvent(new CustomEvent('play-pause-click'))}
              .playbackState=${this.playbackState}
            ></play-pause-button>
            <reset-button
              @click=${() => this.dispatchEvent(new CustomEvent('reset-click'))}
            ></reset-button>
            <add-prompt-button
              @click=${() => this.dispatchEvent(new CustomEvent('add-prompt-click'))}
            ></add-prompt-button>
          </div>
          <div class="prompts-section">
            <h3>Prompts</h3>
            <div class="prompts-list">
              ${[...this.prompts.values()].map(
                (prompt) => html`
                  <div
                    class="prompt-item"
                    style=${styleMap({'border-left': `4px solid ${prompt.color}`})}>
                    <span
                      class="prompt-item-text"
                      contenteditable="plaintext-only"
                      @keydown=${(e: KeyboardEvent) => this._handleTextKeyDown(e, prompt)}
                      @blur=${(e: FocusEvent) => this._updateText(e, prompt)}
                      >${prompt.text}</span
                    >
                    <div class="weight-slider-container">
                      <weight-slider
                        .value=${prompt.weight}
                        .color=${prompt.color}
                        @input=${(e: CustomEvent<number>) =>
                          this._handleWeightChange(e, prompt)}></weight-slider>
                    </div>
                    <button
                      class="remove-button"
                      @click=${() => this._handlePromptRemoved(prompt)}>
                      ×
                    </button>
                  </div>
                `,
              )}
            </div>
          </div>
          <div class="settings-section">
            <h3>Settings</h3>
            <settings-controller></settings-controller>
          </div>
        </div>
      </div>
    `;
  }
}

/** Component for the PromptDJ UI. */
@customElement('prompt-dj')
// Fix: Extend LitElement to make this a valid web component and fix override/property errors.

class PromptDj extends LitElement {
  static override styles = css`
    :host {
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      padding: 2vmin;
      position: relative;
      font-size: 1.8vmin;
      overflow: hidden;
    }
    #background {
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      background: #111;
    }
    .prompts-area {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      flex: 1; /* Take up all available space */
      width: 100%;
      margin-top: 2vmin;
      gap: 2vmin;
      position: relative;
      z-index: 1;
    }
    settings-button {
      width: 12vmin;
      flex-shrink: 0;
    }
    .settings-button-container {
      position: absolute;
      right: 2vmin;
      bottom: 2vmin;
      z-index: 10;
    }
  `;

  @property({
    type: Object,
    attribute: false,
  })
  private prompts: Map<string, Prompt>;
  private nextPromptId: number; // Monotonically increasing ID for new prompts
  private session: LiveMusicSession;
  private readonly sampleRate = 48000;
  // Fix: Cast window to any to access vendor-prefixed webkitAudioContext.
  private audioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: this.sampleRate});
  private outputNode: GainNode = this.audioContext.createGain();
  private nextStartTime = 0;
  private readonly bufferTime = 2; // adds an audio buffer in case of netowrk latency
  @state() private playbackState: PlaybackState = 'stopped';
  @property({type: Object})
  private filteredPrompts = new Set<string>();
  private connectionError = true;
  private lastSettingsConfig: LiveMusicGenerationConfig = {};
  @state() private isModalOpen = false;

  // HR WebSocket
  private hrSocket?: WebSocket;

  // New properties for retry logic
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private reconnectTimeout?: number;

  @query('toast-message') private toastMessage!: ToastMessage;
  @query('settings-controller') private settingsController!: SettingsController;
  @query('log-panel') private logPanel!: LogPanel;
  @query('controls-modal') private controlsModal!: ControlsModal;

  constructor(prompts: Map<string, Prompt>) {
    super();
    this.prompts = prompts;
    this.nextPromptId = this.prompts.size;
    this.outputNode.connect(this.audioContext.destination);
  }

  private redirectConsoleToLogPanel() {
    if (!this.logPanel) {
      console.error('LogPanel not found, cannot redirect console.');
      return;
    }
    const consoleMethods = ['log', 'warn', 'error', 'info', 'debug'];
    for (const methodName of consoleMethods) {
      const originalMethod = console[methodName as keyof Console];
      (console as any)[methodName] = (...args: any[]) => {
        originalMethod.apply(console, args);
        const message = args
          .map((arg) => {
            if (typeof arg === 'object' && arg !== null) {
              try {
                // Truncate long strings (like base64 data) in objects
                return JSON.stringify(arg, (key, value) => {
                  if (
                    key === 'data' &&
                    typeof value === 'string' &&
                    value.length > 100
                  ) {
                    return value.substring(0, 100) + '...[truncated]';
                  }
                  return value;
                });
              } catch (e) {
                return '[Unserializable Object]';
              }
            }
            return String(arg);
          })
          .join(' ');
        this.logPanel.addLog(message);
      };
    }
  }

  override async firstUpdated() {
    console.log("DEBUG: connectToHrSensor() called");
    this.redirectConsoleToLogPanel();
    // The settings controller is now inside the modal's shadow DOM.
    // We need to query it from there.

    await this.updateComplete; // ensure modal is rendered

      const sc = this.controlsModal.shadowRoot?.querySelector<SettingsController>('settings-controller');
        if (sc) {
        this.settingsController = sc;
        this.lastSettingsConfig = this.settingsController.getConfig();
        console.log("DEBUG: settingsController ready");
        } else {
        console.warn("DEBUG: settingsController not found yet");
}

    console.log('Initializing PromptDJ session...');
    await this.connectToSession();
    this.setSessionPrompts();
    this.setSessionConfig();
    this.connectToHrSensor(); //Käynnistä HR-sensori
    this.connectToKinectSensor();   // <- uusi

  }

  // HR WebSocket -integraatio
  private connectToHrSensor() {
    console.log("DEBUG: connectToHrSensor() called");

    const host = window.location.hostname || "localhost";
    this.hrSocket = new WebSocket(`ws://${host}:8765`);

    this.hrSocket.onopen = () => {
      console.log("HR WebSocket connected");
      this.logPanel?.addLog?.("[HR] Connection established");
    };

    this.hrSocket.onmessage = (event) => {
      console.log("HR RAW:", event.data);

      const hrData = parseInt(event.data, 10);
      if (!isNaN(hrData) && hrData > 0) {
        console.log(`[HR] BPM parsed: ${hrData}`);

        // Päivitä asetukset vain jos arvo muuttui
        if (this.lastSettingsConfig.bpm !== hrData) {
          this.lastSettingsConfig = {
            ...this.lastSettingsConfig,
            bpm: hrData,
          };

          //  Päivitä Settings-modal UI
          if (this.settingsController) {
            this.settingsController.updateConfig({ bpm: hrData });
          }

          // Lähetä uusi konfiguraatio musiikkigeneraattorille
          this.setSessionConfig();

          // Lokita UI:n logipaneeliin
          this.logPanel?.addLog(`[HR] BPM set to ${hrData}`);
        }
      } else {
        console.warn("Invalid HR data received:", event.data);
      }
    };

    this.hrSocket.onclose = () => {
      console.warn("HR WebSocket closed. Retrying in 5s...");
      setTimeout(() => this.connectToHrSensor(), 5000);
    };

    this.hrSocket.onerror = (err) => {
      console.error("HR WebSocket error:", err);
      this.hrSocket?.close();
    };
  }
  // HR WebSocket -integraatio loppuu!


// Kinect WebSocket -integraatio
private connectToKinectSensor() {
  console.log("Connecting to Kinect WebSocket at ws://localhost:8766/people...");
  this.kinectSocket = new WebSocket("ws://localhost:8766/people");

  this.kinectSocket.onopen = () => {
    console.log("Kinect WebSocket connected");
    this.logPanel?.addLog?.("[Kinect] Connection established");
  };

  this.kinectSocket.onmessage = (event) => {
    const count = parseInt(event.data, 10);
    if (!isNaN(count)) {
      console.log(`Kinect detected ${count} people`);
      this.logPanel?.addLog?.(`[Kinect] People detected: ${count}`);
      this.applyKinectLogic(count);
    } else {
      console.warn("Invalid Kinect data:", event.data);
    }
  };

  this.kinectSocket.onclose = () => {
    console.warn("Kinect WebSocket closed. Retrying in 5s...");
    setTimeout(() => this.connectToKinectSensor(), 5000);
  };

  this.kinectSocket.onerror = (err) => {
    console.error("Kinect WebSocket error:", err);
    this.kinectSocket?.close();
  };
}

private lastPeopleCount = 0;

private applyKinectLogic(count: number) {
  // Kopioidaan viimeisin config
  let newConfig = { ...this.lastSettingsConfig };

  // Alustetaan kaikki promptit nollaksi
  let ambient = 0;
  let kick = 0;
  let perc = 0;
  let melody = 0;

  // Päätetään asetukset henkilömäärän mukaan
  switch (count) {
    case 0:
      ambient = 0.5;
      break;
    case 1:
      ambient = 0.5;
      kick = 1;
      break;
    case 2:
      ambient = 0.5;
      kick = 2;
      perc = 1;
      break;
    case 3:
      kick = 2;
      perc = 1;
      melody = 0.5;
      break;
    case 4:
      ambient = 0.5;
      kick = 2;
      perc = 1;
      melody = 1;
      break;
    default: // 5 tai enemmän
      ambient = 0.5;
      kick = 2;
      perc = 1;
      melody = 1;
      newConfig.density = 1;
      if (count >= 6) {
        newConfig.topK = 80;
      }
      break;
  }

  // Asetetaan promptien painotukset ja logitetaan muutokset
  this.prompts.forEach((p) => {
    let newWeight = 0;
    if (p.text === "Ambient") newWeight = ambient;
    if (p.text === "Minimal Techno kick") newWeight = kick;
    if (p.text === "Percussions") newWeight = perc;
    if (p.text === "Synthetizer Melody") newWeight = melody;

    if (p.weight !== newWeight) {
      p.weight = newWeight;
      this.logPanel?.addLog?.(`[Kinect] ${p.text} set to ${newWeight}`);
    }
  });

  // Luo uusi satunnainen seed kun tulee uusi henkilö
  if (count > this.lastPeopleCount) {
    newConfig.seed = Math.floor(Math.random() * 100000);
    console.log("New random seed:", newConfig.seed);
    this.logPanel?.addLog?.(`[Kinect] New random seed: ${newConfig.seed}`);
  }
  this.lastPeopleCount = count;

  // Päivitä Settings-UI
  if (this.settingsController) {
    this.settingsController.updateConfig(newConfig);
  }

  // Päivitä config ja promptit
  this.lastSettingsConfig = newConfig;
  this.setSessionConfig();
  this.setSessionPrompts();

  this.requestUpdate();
  this.dispatchPromptsChange();
}
// Kinect integraatio loppuu





  private async connectToSession() {
    console.log(`Connecting to model: ${model}...`);
    try {
      this.session = await ai.live.music.connect({
        model: model,
        callbacks: {
          onmessage: async (e: LiveMusicServerMessage) => {
            // On first successful message, reset reconnect state.
            if (this.reconnectAttempts > 0) {
              console.log('Reconnection successful.');
              this.toastMessage.hide();
            }
            this.reconnectAttempts = 0;
            if (this.reconnectTimeout) {
              clearTimeout(this.reconnectTimeout);
              this.reconnectTimeout = undefined;
            }

            console.debug('Received message from the server:', e);
            if (e.setupComplete) {
              this.connectionError = false;
              console.info('Connection established. Ready to generate.');
            }
            if (e.filteredPrompt) {
              this.filteredPrompts = new Set([
                ...this.filteredPrompts,
                e.filteredPrompt.text,
              ]);
              this.toastMessage.show(e.filteredPrompt.filteredReason);
              console.warn(
                `Prompt filtered: "${e.filteredPrompt.text}" - ${e.filteredPrompt.filteredReason}`,
              );
            }
            if (e.serverContent?.audioChunks?.length) {
              const firstChunk = e.serverContent.audioChunks[0];
              if (!firstChunk?.data) {
                console.warn('Received audio chunk without data.');
                return;
              }

              if (
                this.playbackState === 'paused' ||
                this.playbackState === 'stopped'
              )
                return;
              const audioBuffer = await decodeAudioData(
                decode(firstChunk.data),
                this.audioContext,
                48000,
                2,
              );
              const source = this.audioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              if (this.nextStartTime === 0) {
                const buffer = this.bufferTime;
                this.nextStartTime = this.audioContext.currentTime + buffer;
                setTimeout(() => {
                  this.playbackState = 'playing';
                }, buffer * 1000);
              }

              if (this.nextStartTime < this.audioContext.currentTime) {
                console.warn('Audio buffer underrun. Reloading...');
                this.playbackState = 'loading';
                this.nextStartTime = 0;
                return;
              }
              source.start(this.nextStartTime);
              this.nextStartTime += audioBuffer.duration;
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error(`Connection failure: ${e.message}`);
            this.connectionError = true;
            if (this.playbackState !== 'stopped') {
              this.playbackState = 'loading';
              this.handleConnectionLoss();
            }
          },
          onclose: (e: CloseEvent) => {
            console.log(`Connection closed (code: ${e.code}).`);
            this.connectionError = true;
            // Only retry if the closure was unexpected (not a clean close)
            if (e.code !== 1000 && this.playbackState !== 'stopped') {
              this.playbackState = 'loading';
              this.handleConnectionLoss();
            } else {
              this.stopAudio();
            }
          },
        },
      });
      this.connectionError = false; // Connection call succeeded
    } catch (err) {
      console.error(`Connection failure during connect(): ${err.message}`);
      this.connectionError = true;
      if (this.playbackState !== 'stopped') {
        this.playbackState = 'loading';
        this.handleConnectionLoss();
      }
    }
  }

  private handleConnectionLoss() {
    if (this.reconnectTimeout) return; // a reconnect is already pending

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      const delay = Math.pow(2, this.reconnectAttempts - 1) * 1000;
      console.log(
        `Attempting to reconnect in ${delay / 1000} seconds... (Attempt ${
          this.reconnectAttempts
        }/${this.maxReconnectAttempts})`,
      );
      this.toastMessage.show(
        `Connection lost. Retrying... (${this.reconnectAttempts})`,
      );

      this.reconnectTimeout = window.setTimeout(async () => {
        this.reconnectTimeout = undefined;
        // Check state again in case user stopped it
        if (this.playbackState === 'loading') {
          await this.connectToSession();
          if (!this.connectionError) {
            await this.setSessionPrompts();
            await this.setSessionConfig();
            // The onmessage handler will transition state to 'playing'
          }
        } else {
          console.log('Playback not in loading state, cancelling reconnect.');
          this.reconnectAttempts = 0;
        }
      }, delay);
    } else {
      console.error(
        'Max reconnection attempts reached. Please restart audio manually.',
      );
      this.toastMessage.show(
        'Connection failed. Please restart audio manually.',
      );
      this.stopAudio();
    }
  }

  private setSessionPrompts = throttle(async () => {
    const promptsToSend = Array.from(this.prompts.values())
      .filter((p) => {
        return !this.filteredPrompts.has(p.text) && p.weight !== 0;
      })
      .map(({text, weight}) => ({text, weight}));

    // If there are no active prompts, just pause generation on the server.
    // This prevents sending an empty list, which causes an error.
    if (promptsToSend.length === 0) {
      console.log('No active prompts. Pausing server-side generation.');
      this.session.pause();
      return;
    }

    console.log('Sending updated prompts to server...');
    try {
      // Ensure the session is in a playing state before setting prompts.
      if (this.playbackState === 'playing' || this.playbackState === 'loading') {
        this.session.play();
      }
      await this.session.setWeightedPrompts({
        weightedPrompts: promptsToSend,
      });
    } catch (e) {
      this.toastMessage.show(e.message);
      console.error(`Failed to set prompts: ${e.message}`);
      this.pauseAudio();
    }
  }, 200);

  private dispatchPromptsChange() {
    this.dispatchEvent(
      new CustomEvent('prompts-changed', {detail: this.prompts}),
    );
  }

  private handlePromptChanged(e: CustomEvent<Partial<Prompt>>) {
    const {promptId, text, weight} = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('prompt not found', promptId);
      return;
    }

    let changed = false;
    if (text !== undefined && prompt.text !== text) {
      console.log(`Prompt text changed to "${text}".`);
      prompt.text = text;
      changed = true;
    }

    if (weight !== undefined && prompt.weight !== weight) {
      console.log(`Prompt "${prompt.text}" weight changed to ${weight.toFixed(2)}.`);
      prompt.weight = weight;
      changed = true;
    }

    if (changed) {
      const newPrompts = new Map(this.prompts);
      newPrompts.set(promptId, prompt);
      this.prompts = newPrompts;
      this.setSessionPrompts();
      this.requestUpdate();
      this.dispatchPromptsChange();
    }
  }

  /** Generates radial gradients for each prompt based on weight and color. */
  private makeBackground() {
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

    const MAX_WEIGHT = 0.5;
    const MAX_ALPHA = 0.6;

    const bg: string[] = [];

    [...this.prompts.values()].forEach((p, i) => {
      const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA;
      const alpha = Math.round(alphaPct * 0xff)
        .toString(16)
        .padStart(2, '0');

      const stop = p.weight / 2;
      const x = (i % 4) / 3;
      const y = Math.floor(i / 4) / 3;
      const s = `radial-gradient(circle at ${x * 100}% ${
        y * 100
      }%, ${p.color}${alpha} 0px, ${p.color}00 ${stop * 100}%)`;

      bg.push(s);
    });

    return bg.join(', ');
  }

  private async handlePlayPause() {
    if (this.playbackState === 'playing') {
      this.pauseAudio();
    } else if (
      this.playbackState === 'paused' ||
      this.playbackState === 'stopped'
    ) {
      if (this.connectionError) {
        await this.connectToSession();
        this.setSessionPrompts();
      }
      this.loadAudio();
    } else if (this.playbackState === 'loading') {
      this.stopAudio();
    }
    console.debug('handlePlayPause');
  }

  private pauseAudio() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    this.reconnectAttempts = 0;

    this.session?.pause();
    this.playbackState = 'paused';
    console.log('Audio paused.');
    this.outputNode.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      0,
      this.audioContext.currentTime + 0.1,
    );
    this.nextStartTime = 0;
    this.outputNode = this.audioContext.createGain();
    this.outputNode.connect(this.audioContext.destination);
  }

  private loadAudio() {
    this.audioContext.resume();
    this.session.play();
    this.playbackState = 'loading';
    console.log('Buffering audio...');
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      1,
      this.audioContext.currentTime + 0.1,
    );
  }

  private stopAudio() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    this.reconnectAttempts = 0;

    this.session?.stop();
    this.playbackState = 'stopped';
    console.log('Audio stopped.');
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      1,
      this.audioContext.currentTime + 0.1,
    );
    this.nextStartTime = 0;
  }

  private async handleAddPrompt() {
    const newPromptId = `prompt-${this.nextPromptId++}`;
    const usedColors = [...this.prompts.values()].map((p) => p.color);
    const newPrompt: Prompt = {
      promptId: newPromptId,
      text: 'New Prompt', // Default text
      weight: 0,
      color: getUnusedRandomColor(usedColors),
    };
    console.log('Added new prompt.');
    const newPrompts = new Map(this.prompts);
    newPrompts.set(newPromptId, newPrompt);
    this.prompts = newPrompts;

    await this.setSessionPrompts();
  }

  private handlePromptRemoved(e: CustomEvent<string>) {
    e.stopPropagation();
    const promptIdToRemove = e.detail;
    if (this.prompts.has(promptIdToRemove)) {
      console.log('Removed prompt.');
      this.prompts.delete(promptIdToRemove);
      const newPrompts = new Map(this.prompts);
      this.prompts = newPrompts;
      this.setSessionPrompts();
      this.dispatchPromptsChange();
    } else {
      console.warn(
        `Attempted to remove non-existent prompt ID: ${promptIdToRemove}`,
      );
    }
  }

  private async setSessionConfig() {
    try {
      await this.session?.setMusicGenerationConfig({
        musicGenerationConfig: this.lastSettingsConfig,
      });
    } catch (e) {
      this.toastMessage.show(e.message);
      console.error(`Failed to set music generation config: ${e.message}`);
    }
  }

  private updateSettings = throttle(
    async (e: CustomEvent<LiveMusicGenerationConfig>) => {
      const newConfig = e.detail;
      const changedLogs: string[] = [];

      const formatValue = (value: any): string => {
        if (
          value === undefined ||
          value === null ||
          (typeof value === 'string' && value.trim() === '')
        ) {
          return 'auto';
        }
        if (typeof value === 'number') {
          return Number.isInteger(value) ? value.toString() : value.toFixed(2);
        }
        return String(value);
      };

      const allKeys = new Set([
        ...Object.keys(this.lastSettingsConfig),
        ...Object.keys(newConfig),
      ]) as Set<keyof LiveMusicGenerationConfig>;

      for (const key of allKeys) {
        const oldValue = this.lastSettingsConfig[key];
        const newValue = newConfig[key];

        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          // Fix: Explicitly convert `key` to a string to prevent potential runtime errors
          // with symbol keys in template literals.
          changedLogs.push(`  ${String(key)}: ${formatValue(newValue)}`);
        }
      }

      // Only send to session and log if there are actual changes
      if (changedLogs.length > 0) {
        console.log('Updating music generation settings...');
        changedLogs.forEach((log) => console.log(log));

        this.lastSettingsConfig = {...newConfig};
        await this.setSessionConfig();
      }
    },
    200,
  );

  private async handleReset() {
    console.log('Resetting music context...');
    if (this.connectionError) {
      await this.connectToSession();
      this.setSessionPrompts();
    }
    this.pauseAudio();
    this.session.resetContext();
    this.settingsController.resetToDefaults();
    this.session?.setMusicGenerationConfig({
      musicGenerationConfig: {},
    });
    setTimeout(this.loadAudio.bind(this), 100);
  }

  private toggleModal() {
    this.isModalOpen = !this.isModalOpen;
  }

  override render() {
    const bg = styleMap({
      backgroundImage: this.makeBackground(),
    });
    return html` <div id="background" style=${bg}></div>
      <log-panel></log-panel>
      <div class="prompts-area"></div>

      <div class="settings-button-container">
        <settings-button @click=${this.toggleModal}></settings-button>
      </div>

      <controls-modal
        .showing=${this.isModalOpen}
        .prompts=${this.prompts}
        .playbackState=${this.playbackState}
        @close-modal=${this.toggleModal}
        @prompt-changed=${this.handlePromptChanged}
        @prompt-removed=${this.handlePromptRemoved}
        @play-pause-click=${this.handlePlayPause}
        @reset-click=${this.handleReset}
        @add-prompt-click=${this.handleAddPrompt}
        @settings-changed=${this.updateSettings}></controls-modal>
      <toast-message></toast-message>`;
  }
}

function gen(parent: HTMLElement) {
  const initialPrompts = getStoredPrompts();

  const pdj = new PromptDj(initialPrompts);
  parent.appendChild(pdj);
}

function getStoredPrompts(): Map<string, Prompt> {
  const {localStorage} = window;
  const storedPrompts = localStorage.getItem('prompts');

  if (storedPrompts) {
    try {
      const prompts = JSON.parse(storedPrompts) as Prompt[];
      console.log('Loading stored prompts', prompts);
      return new Map(prompts.map((prompt) => [prompt.promptId, prompt]));
    } catch (e) {
      console.error('Failed to parse stored prompts', e);
    }
  }

  console.log('No stored prompts, creating prompt presets');

  const numDefaultPrompts = Math.min(4, PROMPT_TEXT_PRESETS.length);
  const shuffledPresetTexts = [...PROMPT_TEXT_PRESETS].sort(
    () => Math.random() - 0.5,
  );
  const defaultPrompts: Prompt[] = [];
  const usedColors: string[] = [];
  for (let i = 0; i < numDefaultPrompts; i++) {
    const text = shuffledPresetTexts[i];
    const color = getUnusedRandomColor(usedColors);
    usedColors.push(color);
    defaultPrompts.push({
      promptId: `prompt-${i}`,
      text,
      weight: 0,
      color,
    });
  }
  // Randomly select up to 2 prompts to set their weight to 1.
  const promptsToActivate = [...defaultPrompts].sort(() => Math.random() - 0.5);
  const numToActivate = Math.min(2, defaultPrompts.length);
  for (let i = 0; i < numToActivate; i++) {
    if (promptsToActivate[i]) {
      promptsToActivate[i].weight = 1;
    }
  }
  return new Map(defaultPrompts.map((p) => [p.promptId, p]));
}

function setStoredPrompts(prompts: Map<string, Prompt>) {
  const storedPrompts = JSON.stringify([...prompts.values()]);
  const {localStorage} = window;
  localStorage.setItem('prompts', storedPrompts);
}

function main(container: HTMLElement) {
  gen(container);
}

main(document.body);

declare global {
  interface HTMLElementTagNameMap {
    'prompt-dj': PromptDj;
    'settings-controller': SettingsController;
    'add-prompt-button': AddPromptButton;
    'play-pause-button': PlayPauseButton;
    'reset-button': ResetButton;
    'weight-slider': WeightSlider;
    'toast-message': ToastMessage;
    'log-panel': LogPanel;
    'horizontal-slider': HorizontalSlider;
    'settings-button': SettingsButton;
    'controls-modal': ControlsModal;
  }
}
