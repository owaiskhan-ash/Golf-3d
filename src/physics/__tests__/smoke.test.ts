/**
 * Smoke tests: importing every non-DOM module must not throw, and core data tables
 * (course holes, club bag) must be internally consistent.
 */
import { describe, expect, it } from 'vitest';

import * as courseData from '../../course/courseData';
import * as noise from '../../course/noise';
import * as terrainSampler from '../../course/terrainSampler';
import * as types from '../../course/types';
import * as aerodynamics from '../aerodynamics';
import * as bounceAndRoll from '../bounceAndRoll';
import * as clubs from '../clubs';
import * as collisions from '../collisions';
import * as constants from '../constants';
import * as launchModel from '../launchModel';
import * as simulation from '../simulation';
import * as surfaces from '../surfaces';
import * as roundStorage from '../../storage/roundStorage';
import * as supabaseSync from '../../storage/supabaseSync';

describe('module smoke imports', () => {
  it('all core modules import without side-effect errors', () => {
    const modules = [
      courseData,
      noise,
      terrainSampler,
      types,
      aerodynamics,
      bounceAndRoll,
      clubs,
      collisions,
      constants,
      launchModel,
      simulation,
      surfaces,
      roundStorage,
      supabaseSync,
    ];
    for (const m of modules) {
      // note: type-only modules (course/types) compile to an empty namespace object
      expect(m).toBeDefined();
    }
  });

  it('course data integrity', () => {
    const { COURSE_HOLES, getHoleById } = courseData;
    expect(COURSE_HOLES.length).toBeGreaterThan(0);
    for (const h of COURSE_HOLES) {
      expect(getHoleById(h.id).id).toBe(h.id);
      expect(h.par).toBeGreaterThanOrEqual(3);
      expect(h.bounds.minX).toBeLessThan(h.bounds.maxX);
      expect(h.bounds.minZ).toBeLessThan(h.bounds.maxZ);
      expect(h.fairwaySplines.length).toBeGreaterThan(0);
      expect(Number.isFinite(h.tee.cx)).toBe(true);
      expect(Number.isFinite(h.green.cx)).toBe(true);
    }
  });

  it('club bag is sane and lookups round-trip', () => {
    expect(clubs.CLUB_BAG.length).toBeGreaterThan(5);
    for (const c of clubs.CLUB_BAG) {
      const c2 = clubs.getClubById(c.id);
      expect(c2.id).toBe(c.id);
      expect(Number.isFinite(c2.tourAttackAngleDeg)).toBe(true);
    }
    // Unknown ids fall back safely instead of returning undefined
    expect(clubs.getClubById('NOPE')).toBeDefined();
  });
});
