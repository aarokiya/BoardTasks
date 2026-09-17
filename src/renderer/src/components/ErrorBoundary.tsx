import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { Button } from './Button';
import { IconAlert } from './icons';
import s from './feedback.module.css';

export type BoundaryLevel = 'app' | 'pane' | 'row';

export interface ErrorBoundaryProps {
  level: BoundaryLevel;
  /** Shown in the pane/app fallback ("Sidebar", "Task list"…). */
  name: string;
  /** Plain-text fallback for a row. */
  rowText?: string;
  children: ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Three levels of containment: a throwing row degrades to a text row, a
 * throwing pane leaves the rest of the app usable, and the app-level boundary
 * is the last resort.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[BoardTasks] ${this.props.level} boundary "${this.props.name}" caught:`, error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.level === 'row') {
      return (
        <div className={s.boundaryRow} role="treeitem" aria-selected={false} aria-level={1}>
          {this.props.rowText ?? 'This task could not be displayed.'}
        </div>
      );
    }

    return (
      <div className={s.boundary} role="alert">
        <IconAlert size={22} />
        <div className={s.boundaryTitle}>
          {this.props.level === 'app' ? 'BoardTasks hit an unexpected error' : `${this.props.name} could not be displayed`}
        </div>
        <div className={s.boundaryDetail}>{error.message}</div>
        <Button variant="secondary" onClick={this.reset}>
          Try again
        </Button>
      </div>
    );
  }
}

/** Convenience wrapper so a row fallback stays a single plain element. */
export function RowBoundary({ rowText, children }: { rowText: string; children: ReactNode }): ReactElement {
  return (
    <ErrorBoundary level="row" name="Task row" rowText={rowText}>
      {children}
    </ErrorBoundary>
  );
}
