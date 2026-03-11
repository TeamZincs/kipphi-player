export interface PhiraRespackConfig {
  /** 资源包的名字 */
  name: string;
  /** 资源包的作者 */
  author: string;
  /** 资源包介绍 */
  description?: string;
  /** 打击特效宽、高的帧数 [宽帧数, 高帧数] */
  hitFx: [number, number];
  /** Hold贴图的尾、头高度 [尾部高度, 头部高度] */
  holdAtlas: [number, number];
  /** 多押Hold的尾、头高度 [尾部高度, 头部高度] */
  holdAtlasMH: [number, number];
  /** 打击特效的持续时间，以秒为单位，默认 0.5 */
  hitFxDuration?: number;
  /** 打击特效缩放比例，默认 1.0 */
  hitFxScale?: number;
  /** 打击特效是否随Note旋转，默认 false */
  hitFxRotate?: boolean;
  /** 打击特效是否依照判定线颜色着色，默认 true */
  hitFxTinted?: boolean;
  /** 打击时是否隐藏方形粒子效果，默认 false */
  hideParticles?: boolean;
  /** Hold触线后是否还显示头部，默认 false */
  holdKeepHead?: boolean;
  /** Hold的中间部分是否采用重复式拉伸，默认 false */
  holdRepeat?: boolean;
  /** 是否把Hold的头部和尾部与Hold中间重叠（将锚点居中），默认 false */
  holdCompact?: boolean;
  /** AP（全Perfect）情况下的判定线颜色，默认 0xe1ffec9f */
  colorPerfect?: number;
  /** FC（全连）情况下的判定线颜色，默认 0xebb4e1ff */
  colorGood?: number;
}

