/**
 * Empty session swimlane boundary. Story 4 will populate this surface from the
 * already-loaded session model without changing the surrounding view chrome.
 */
export const SwimlaneSurface = (): JSX.Element => {
  return (
    <section
      aria-label="Session swimlane"
      data-testid="swimlane-surface"
      className="absolute inset-0 overflow-y-auto"
      style={{ backgroundColor: 'var(--color-surface)' }}
    />
  );
};
