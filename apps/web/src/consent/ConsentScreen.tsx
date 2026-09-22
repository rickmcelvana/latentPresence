import type { ReactElement } from 'react';
import type { ModelDescriptor } from '@latentpresence/protocol';
import { formatMb } from './format';

/**
 * The model-download consent screen (P1-T13): CLAUDE.md's "nothing downloads without the
 * consent screen (size, licence, source)" and ADR-09, rendered.
 *
 * One component for every caller that needs weights before it can run — `/dev/voice` today,
 * `/settings`'s Voice and Hearing sections once they drive a real browser provider. It shows
 * nothing itself and downloads nothing itself; a caller renders this in place of whatever it
 * was about to build, and only calls the thing that actually fetches once `onAgree` fires.
 * `ModelConsent.grant` is the caller's job, not this component's, so a test can render it
 * against a plain array with no `ModelConsent` in sight.
 */
export interface ConsentScreenProps {
  readonly descriptors: readonly ModelDescriptor[];
  readonly onAgree: () => void;
  readonly onCancel: () => void;
}

export function ConsentScreen({ descriptors, onAgree, onCancel }: ConsentScreenProps): ReactElement {
  const total = descriptors.reduce((sum, descriptor) => sum + descriptor.sizeBytes, 0);

  return (
    <section className="panel consent-screen">
      <div className="panel-header">
        <span className="panel-title">This will download models</span>
        <span className="pill pill-accent">{formatMb(total)} total</span>
      </div>
      <p className="consent-note">
        These come from Hugging Face to this computer. They stay in this browser — nothing is sent anywhere.
      </p>
      <ul className="consent-models">
        {descriptors.map((descriptor) => (
          <li className="consent-model" key={descriptor.id}>
            <span className="consent-model-name">{descriptor.label}</span>
            <span className="consent-model-meta">
              {formatMb(descriptor.sizeBytes)} · {descriptor.licence} ·{' '}
              <a href={descriptor.sourceUrl} rel="noreferrer" target="_blank">
                source
              </a>
            </span>
          </li>
        ))}
      </ul>
      <div className="consent-actions">
        <button className="btn btn-primary" onClick={onAgree} type="button">
          Agree
        </button>
        <button className="btn btn-ghost" onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </section>
  );
}
