"""Model sidecar. Weights stay outside the repo. Jobs are asynchronous."""

from cutroom_sidecar.jobs import JobKind

__all__ = ["JobKind"]
