import { describe, it, expect } from 'vitest';
import {
  ANSWER_RELEVANCY_CALIBRATION,
  FAITHFULNESS_CALIBRATION,
  LOGICAL_COHERENCE_CALIBRATION,
  getCalibrationSet,
} from '../../src/assertions/calibration-data.js';

describe('Calibration Data', () => {
  it('all calibration sets have 3 examples each', () => {
    expect(ANSWER_RELEVANCY_CALIBRATION).toHaveLength(3);
    expect(FAITHFULNESS_CALIBRATION).toHaveLength(3);
    expect(LOGICAL_COHERENCE_CALIBRATION).toHaveLength(3);
  });

  it('all ground truth scores are in [0, 1]', () => {
    const allExamples = [
      ...ANSWER_RELEVANCY_CALIBRATION,
      ...FAITHFULNESS_CALIBRATION,
      ...LOGICAL_COHERENCE_CALIBRATION,
    ];
    for (const ex of allExamples) {
      expect(ex.groundTruthScore).toBeGreaterThanOrEqual(0);
      expect(ex.groundTruthScore).toBeLessThanOrEqual(1);
    }
  });

  it('getCalibrationSet returns correct set by metric name', () => {
    expect(getCalibrationSet('answer_relevancy')).toBe(ANSWER_RELEVANCY_CALIBRATION);
    expect(getCalibrationSet('faithfulness')).toBe(FAITHFULNESS_CALIBRATION);
    expect(getCalibrationSet('logical_coherence')).toBe(LOGICAL_COHERENCE_CALIBRATION);
  });

  it('getCalibrationSet returns empty array for unknown metric', () => {
    expect(getCalibrationSet('nonexistent')).toEqual([]);
    expect(getCalibrationSet('')).toEqual([]);
  });

  it('all examples have required fields', () => {
    const allExamples = [
      ...ANSWER_RELEVANCY_CALIBRATION,
      ...FAITHFULNESS_CALIBRATION,
      ...LOGICAL_COHERENCE_CALIBRATION,
    ];
    for (const ex of allExamples) {
      expect(typeof ex.input).toBe('string');
      expect(typeof ex.expectedOutput).toBe('string');
      expect(typeof ex.actualOutput).toBe('string');
      expect(typeof ex.groundTruthScore).toBe('number');
      expect(ex.input.length).toBeGreaterThan(0);
      expect(ex.actualOutput.length).toBeGreaterThan(0);
    }
  });
});
