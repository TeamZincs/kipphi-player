export interface ResourceItem {
  name: string;
  file: string;
}

export interface NoteSkin extends ResourceItem {}

export interface HitSound extends ResourceItem {}

export interface ParticleConfig {
  count: number;
  style: string;
}

export interface HitEffects {
  spriteSheet: string;
  frameWidth: number;
  frameHeight: number;
  frameRate: number;
  particle: ParticleConfig;
}

export interface Grade {
  name: string;
  file: string;
}

export interface EndingMusic {
  levelType: number;
  beats: number;
  bpm: number;
  file: string;
}

export interface Ending {
  grades: Grade[];
  music: EndingMusic[];
}

export interface TrueTypeFont {
  name: string;
  type: 'truetype';
  file: string;
}

export interface BitmapFont {
  name: string;
  type: 'bitmap';
  texture: string;
  descriptor: string;
}

export type Font = TrueTypeFont | BitmapFont;

export interface MetaConfig {
  name: string;
  author: string;
  description: string;
  thumbnail: string;
  noteSkins: NoteSkin[];
  hitSounds: HitSound[];
  hitEffects: HitEffects;
  ending: Ending;
  fonts: Font[];
  options: Record<string, unknown>;
}
