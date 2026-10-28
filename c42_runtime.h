#ifndef C42_RUNTIME_H
#define C42_RUNTIME_H

#include <assert.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#ifndef MIN
#define MIN(a, b) (((a) < (b)) ? (a) : (b))
#endif

#define SUSPEND_CONTEXT_SPACE_IMPLIED_BY(fn) SuspendContext_##fn

typedef enum PromiseStatus {
  PENDING = 0,
  RESOLVED,
  REJECTED,
  PINGED,
  TO_BE_PINGED,
  RESOLVE = RESOLVED,
  REJECT = REJECTED
} PromiseStatus;

struct C42Promise;
typedef struct C42Promise AtomicPromise;
typedef struct C42Promise *Promise;

typedef struct ResumeContext {
  void (*resume)(void *suspend_ctx, Promise settled);
  void *suspend_ctx;
  struct ResumeContext *next;
} ResumeContext;

struct C42Promise {
  volatile int status;
  void *result;
  ResumeContext sites[8];
  size_t sites_count;
};

typedef struct C42ClosureHeader {
  void (*invoke)(void *self);
  void (*catch_handler)(void *self, void *err);
  AtomicPromise cancel_promise;
  bool heap_allocated;
} C42ClosureHeader;

static _Thread_local void *CURRENT_SUSPEND_CONTEXT = NULL;

typedef int64_t Timeval;

#define C42_TIMER_DEFINED
typedef struct Timer {
  Timeval expiry;
  Promise *toPing;
  PromiseStatus pingType;
} Timer;

extern Timer timers[8];

static inline Timeval getTimeOfDay(Timeval *out) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  Timeval now = (Timeval)tv.tv_sec * 1000000LL + (Timeval)tv.tv_usec;
  if (out) *out = now;
  return now;
}

#define CollectionsListSplice(arr, idx, count)                                 \
  do {                                                                         \
    size_t _idx = (size_t)(idx);                                               \
    size_t _cnt = (size_t)(count);                                             \
    size_t _len = sizeof(arr) / sizeof((arr)[0]);                              \
    if (_idx + _cnt < _len) {                                                  \
      memmove(&(arr)[_idx], &(arr)[_idx + _cnt],                               \
              (_len - _idx - _cnt) * sizeof((arr)[0]));                        \
    }                                                                          \
    memset(&(arr)[_len - _cnt], 0, _cnt * sizeof((arr)[0]));                   \
  } while (0)

static inline Promise newPromise(void) {
  Promise p = (Promise)calloc(1, sizeof(struct C42Promise));
  if (p) p->status = PENDING;
  return p;
}

static inline void c42_subscribe(Promise p,
                                 void (*resume)(void *suspend_ctx, Promise settled),
                                 void *suspend_ctx) {
  if (!p || !resume) return;
  if (p->status == RESOLVED || p->status == REJECTED) {
    resume(suspend_ctx, p);
    return;
  }
  if (p->sites_count < 8) {
    p->sites[p->sites_count].resume = resume;
    p->sites[p->sites_count].suspend_ctx = suspend_ctx;
    p->sites_count++;
  }
}

static inline void promise_unsubscribe(Promise p, void *suspend_ctx) {
  if (!p) return;
  for (size_t i = 0; i < p->sites_count; i++) {
    if (p->sites[i].suspend_ctx == suspend_ctx) {
      for (size_t j = i; j + 1 < p->sites_count; j++) {
        p->sites[j] = p->sites[j + 1];
      }
      p->sites_count--;
      i--;
    }
  }
}

static inline void c42_notify_subscribers(Promise p) {
  if (!p) return;
  ResumeContext snapshot[8];
  size_t count = p->sites_count;
  for (size_t i = 0; i < count; i++) {
    snapshot[i] = p->sites[i];
  }
  for (size_t i = 0; i < count; i++) {
    if (snapshot[i].resume) {
      void *prev = CURRENT_SUSPEND_CONTEXT;
      CURRENT_SUSPEND_CONTEXT = snapshot[i].suspend_ctx;
      snapshot[i].resume(snapshot[i].suspend_ctx, p);
      CURRENT_SUSPEND_CONTEXT = prev;
    }
  }
}

static inline void promise_resolve(Promise p, void *result) {
  if (!p || p->status == RESOLVED || p->status == REJECTED) return;
  p->status = RESOLVED;
  p->result = result;
  c42_notify_subscribers(p);
}

static inline void promise_reject(Promise p, void *error) {
  if (!p || p->status == RESOLVED || p->status == REJECTED) return;
  p->status = REJECTED;
  p->result = error;
  c42_notify_subscribers(p);
}

static inline void promise_cancel(Promise p) {
  for (size_t i = 0; i < 8 && timers[i].toPing != NULL; i++) {
    if (*timers[i].toPing == p) {
      CollectionsListSplice(timers, i, 1);
      i--;
    }
  }
  promise_reject(p, (void *)"CancellationException");
}

static inline void promise_ping(Promise p) {
  if (!p) return;
  do {
    p->status = PINGED;
    c42_notify_subscribers(p);
  } while (p->status == TO_BE_PINGED);
  if (p->status == PINGED) {
    p->status = PENDING;
  }
}

static inline void promise_do_op(PromiseStatus op, Promise *toPing) {
  if (!toPing || !*toPing) return;
  Promise p = *toPing;
  if (op == RESOLVE) {
    promise_resolve(p, NULL);
  } else if (op == REJECT) {
    promise_reject(p, (void *)"TimeoutException");
  } else if (op == PINGED || op == TO_BE_PINGED) {
    promise_ping(p);
  }
}

static inline bool promise_race_check(Promise *list) {
  if (!list) return true;
  for (size_t i = 0; list[i] != NULL; i++) {
    if (list[i]->status == RESOLVED || list[i]->status == REJECTED) {
      return true;
    }
  }
  return false;
}

static inline Promise c42_schedule_timer(uint64_t duration_us, PromiseStatus ping_type) {
  Promise p = newPromise();
  Promise *slot = (Promise *)malloc(sizeof(Promise));
  *slot = p;
  for (size_t i = 0; i < 8; i++) {
    if (timers[i].toPing == NULL) {
      timers[i].expiry = getTimeOfDay(NULL) + (Timeval)duration_us;
      timers[i].toPing = slot;
      timers[i].pingType = ping_type;
      break;
    }
  }
  return p;
}

static inline Promise promise_timeout(uint64_t duration_us) {
  return c42_schedule_timer(duration_us, RESOLVE);
}

static inline Promise promise_timeout_reject(uint64_t duration_us) {
  return c42_schedule_timer(duration_us, REJECT);
}

static inline void c42_closure_trampoline(void *suspend_ctx, Promise settled) {
  C42ClosureHeader *hdr = (C42ClosureHeader *)suspend_ctx;
  if (!hdr) return;
  if (settled && settled->status == REJECTED && hdr->catch_handler) {
    hdr->catch_handler(suspend_ctx, settled->result);
  } else if (hdr->invoke) {
    hdr->invoke(suspend_ctx);
  }
}

static inline void c42_promise_then(Promise p,
                                    void *closure_storage,
                                    void (*invoke)(void *),
                                    void (*catch_handler)(void *, void *)) {
  C42ClosureHeader *hdr = (C42ClosureHeader *)closure_storage;
  if (hdr) {
    hdr->invoke = invoke;
    hdr->catch_handler = catch_handler;
    hdr->cancel_promise.status = PENDING;
    hdr->cancel_promise.sites_count = 0;
  }
  c42_subscribe(p, c42_closure_trampoline, closure_storage);
}

static inline void c42_await_promise(Promise p,
                                     void (*resume)(void *, Promise),
                                     void *ctx) {
  c42_subscribe(p, resume, ctx);
}

static inline void c42_await_race2(Promise p1,
                                   Promise p2,
                                   void (*resume)(void *, Promise),
                                   void *ctx) {
  if (p1 && (p1->status == RESOLVED || p1->status == REJECTED)) {
    resume(ctx, p1);
    return;
  }
  if (p2 && (p2->status == RESOLVED || p2->status == REJECTED)) {
    resume(ctx, p2);
    return;
  }
  c42_subscribe(p1, resume, ctx);
  c42_subscribe(p2, resume, ctx);
}

static inline void c42_await_closure_cancel(void *closure_storage,
                                            void (*resume)(void *, Promise),
                                            void *ctx) {
  C42ClosureHeader *hdr = (C42ClosureHeader *)closure_storage;
  if (!hdr) return;
  c42_subscribe(&hdr->cancel_promise, resume, ctx);
  if (hdr->catch_handler) {
    hdr->catch_handler(closure_storage, (void *)"CancellationException");
  } else {
    promise_resolve(&hdr->cancel_promise, NULL);
  }
}

static inline void closure_free(void *closure_storage) {
  C42ClosureHeader *hdr = (C42ClosureHeader *)closure_storage;
  if (!hdr) return;
  promise_resolve(&hdr->cancel_promise, NULL);
  if (hdr->heap_allocated) {
    free(closure_storage);
  }
}

static inline const char *c42_format_error(void *err) {
  return err ? (const char *)err : "UnknownError";
}

#endif /* C42_RUNTIME_H */
