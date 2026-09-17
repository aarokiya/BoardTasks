import type { Routes } from '../router';
import { notImplemented } from './_stub';

type WindowRoutes = Pick<Routes, 'window:quickAddSubmit' | 'window:hideQuickAdd' | 'window:showMain' | 'window:resizeQuickAdd'>;

export function windowRoutes(): WindowRoutes {
  return {
    'window:quickAddSubmit': notImplemented('window:quickAddSubmit'),
    'window:hideQuickAdd': notImplemented('window:hideQuickAdd'),
    'window:showMain': notImplemented('window:showMain'),
    'window:resizeQuickAdd': notImplemented('window:resizeQuickAdd'),
  };
}
