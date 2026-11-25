import { useEffect, useState } from 'react';

/**
 * Reactive viewport-width check. Returns true when the viewport is narrower
 * than `breakpoint` px (default 768 = Tailwind's `md`). Used to swap the
 * desktop HUD chrome for the minimal mobile HUD with an icon side menu.
 */
export const useIsMobile = (breakpoint = 768): boolean => {
  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < breakpoint
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [breakpoint]);

  return isMobile;
};
