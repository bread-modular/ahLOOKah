import { FEATURE_SCHEMA, createReactiveController } from '../sketches/feature-controls.js';
import { NODE_AUDIO_SIGNAL_PATTERN_ID } from '../pattern-audio-protocol.js';
// Reserved, non-visual signal controller resolved only by the audio engine.
// The id is owned by the transport protocol so plan/controls validation and the
// registered source can never drift apart.
export const NODE_AUDIO_SOURCE = { id: NODE_AUDIO_SIGNAL_PATTERN_ID, params: [], audioTransport: 'pattern-controls', audioControlSchema: FEATURE_SCHEMA, createAudioController: createReactiveController };
