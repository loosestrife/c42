/* c42trans --c42-policy c42.json test.c42 -o test.c
 * it is a historical accident that every relational algebra language is sql
 * c42 is yet another "transitional algebra" language.  Promise and SuspendContext/Closure are nodes, ResumeContext is an edge
 * the intention is that c42 is capable of expressing anyones state machine
 * ...while using the minimum resources required, whether memory, time,
   realtime maximum execution time, 
 * ...while having mostly shared syntax between those minimal resources requirements
 * ...while not being too complicated to just dive into in a day
 * ...while being compatible with and usable in c projects
 * the c42.json sets the projects policy about enabling of c42 features,
   how async works, heap usage, what CollectionsList* do, what String* do, ...
 * async functions get split into foo_start, foo_after_p
   foo_after_race_reject, ..., like a boring c programmer would, then he would write the c42 code to show his friends a high level overview of what he did
 * automatic struct SuspendContext_foo for _context variables
 * automatic extern int SuspendContextSize_foo for preallocation
 * Closure_foo_1 function with struct ClosureStorage_foo_1 and extern int ClosureSize_foo_1
 * NEXT_CLOSURE_STORAGE magic to find out the size of the next closure declared
 * SUSPEND_CONTEXT_SPACE_IMPLIED_BY(foo) grabs SuspendContextSize_foo
 * with(buf) foo() and with(buf) ^{} to preallocate storage
 * with(buf) foo() is basically a macro to inject buf in the
   CURRENT_SUSPEND_CONTEXT, which is passed in like r13 on amd64 or maybe 
   a thread local variable, it is set by the transitional algebra graph state
   machine ops and also by with()
 * THIS_CLOSURE gets the current closure storage.  heapless c42 doesnt have
   heap closures that are responsible for freeing themselves, sometimes the
   preallocated and heap using programs have inevitable differences
 * struct ResumeContext { *(void*) resume; void* SuspendContext; }
 * struct Promise { int status; void* result; ResumeContext(* or [N]) sites; }
     or ResumeContext* sites_head; and we chain ResumeContext's as a linked list
 * enum PromiseStatus { PENDING, RESOLVED, REJECTED, PINGED, TO_BE_PINGED }
 * struct SuspendContext {
     void* _c42_previousSuspendContext;
     // Promise back links here
     // context vars here }
 * naturally, the project lead can write whatever structs and promise_*
   functions is most useful for the project.  c42 hopes to turn standard syntax
   into your semantics with a tree-sitter based transpiler that turns c42
   primitives into macros and declaration hoisting
*/

#include <cstdint>
#include <stdio.h>
#include <aio.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <time.h>
#include <c42_runtime.h>

/* it is perfectly possible to have a volatile atomic int status for special 
 * signal handler promises */
AtomicPromise signal_repeated_promise;

void install_signal_handler(){
  /* n.b. this is not a closure, its just an anonymous function
    ClosureStorage_install_signal_handler_1 is empty
    Closure_install_signal_handler_1 is just a function */ 
  signal(SIGUSR1, ^{signal_repeated_promise.status = TO_BE_PINGED;});
}

void callbacker_read(char*! path, void*! buf, size_t bufSz, size_t offset, (*callback)(int, char*)) {
  _context FILE *ifp = fopen(path, "r");
  if(ifp == NULL){
    callback(0,"fopen failed");
    return;
  }
  // this is _context for later
  _context struct aiocb cb;
  cb.aio_fildes = fileno(ifp);
  cb.aio_buf = buf;
  cb.aio_nbytes = bufSz;
  cb.aio_offset = offset;
  cb.aio_sigevent.sigev_notify = SIGEV_SIGNAL;
  cb.aio_sigevent.sigev_signo = SIGUSR1;
  if (aio_read(&cb) == -1) {
    callback(0,"aio_read failed");
    return;
  }
  /* NEXT_CLOSURE_STORAGE is a magic macro for ClosureStorage_callbacker_read_1
   * _context puts it in SuspendContext_callbacker_read
   * there are three colors of function in c42, vanilla, chocolate (async)
   * and twist (vanilla with a closure).  with() is used to give chocolate
   * and twist functions storage space, by injecting that space into a thread
   * local variable CURRENT_SUSPEND_CONTEXT.  so if callbacker_read was called
   * without a with, being a twist function, it doesnt actually need a
   * SuspendContext.  But its closures need their ClosureStorage's, so it has
   * to malloc() only those.  Since the user opted in to malloc()'d closures,
   * the user is responsible for the closures freeing themselves.
   * By the way if callbacker_read was somehow still around to want to know the
   * variables of its closures, it could allocate storage for them.  so in
   * reality these are chocolate closures, not vanilla lambdas or a twist. */
  _context NEXT_CLOSURE_STORAGE closureStorageAllocation;
  promise_then(&signal_repeated_promise, ^{
    int status = aio_error(&cb);
    if(status == EINPROGRESS){
      return;
    }
    if(status == 0){
      callback(aio_return(&cb), NULL);
    } else if (status != EINPROGRESS){
      callback(0, strerror(status));
    }
    fclose(ifp);
    promise_unsubscribe(&signal_repeated_promise, THIS_CLOSURE);
    /* under some circumstances it is not safe for closures to free themselves immediately, therefore closure_free can defer the free call */
    closure_free(THIS_CLOSURE);
  } catch(e) {
    /* e could be a CancellationException or some other exception */
    promise_unsubscribe(&signal_repeated_promise, THIS_CLOSURE);
    while(aio_cancel(cb.aio_fildes, NULL) == AIO_NOTCANCELED){
      /* kick back to the event loop and wait for permission to free(buf).
       * if aio_cancel was asynchronous then we would
       * await signal_repeated_promise;
       * if(*aio_cancel_buf != AIO_NOTCANCELED);
       * like we should have done in callbacker_read but callbacker_read
       * is poorly written to show how every single feature interacts */
      await promise_timeout(1_000_000);
    }
    fclose(ifp);
    closure_free(THIS_CLOSURE);
  });
}  

typedef struct Timer {
  Timeval expiry;
  Promise* toPing;
  PromiseStatus pingType;
} Timer;
Timer timers[8];
/* this is a ten line toy to demonstrate an event loop, a real program would
 * use glib or libuv or whatever */
void basic_usleep_event_loop(Promise* eventLoopWaitsForThese){
  do {
    if(promise_to_ping_on_signal.status == TO_BE_PINGED){
      /* n.b. promise_ping needs to have a do loop to set PINGED, then check TO_BE_PINGED after execution, then return to PENDING */
      promise_ping(promise_to_ping_on_signal);
    }
    bool pings;
    Timeval now;
    do {
      pings = false;
      now = getTimeOfDay(&now);
      for(Timer* t = timers; t < timers + 8 && t->toPing != NULL; t++){
        if(now > t->expiry){
          pings = true;
          promise_do_op(t->pingType, t->toPing);
          if(t->pingType == RESOLVE || t->pingType == REJECT){
            CollectionsListSplice(timers, t-timers, 1);
            t--;
          }
          now = getTimeOfDay(&now);
        }
      }
    } while(pings);
    uint32 waketime = 1_000_000;
    for(Timer* t = timers; t < timers + 8 && t->toPing != NULL; t++){
      uint32 t_waketime = (t->expiry - now)/1000;
      waketime = MIN(waketime, t_waketime);
    }
    // PROMISE_MACHINE_RUN_PENDING_PROMISES goes here for deferred execution
    if(promise_race_check(eventLoopWaitsForThese)){
      return;
    };
    usleep(waketime);
  } while(1);
}

int main(int argc, char *!*argv){
  install_signal_handler();
  // top level await is not allowed in c42 because cant name mangle main
  SUSPEND_CONTEXT_SPACE_IMPLIED_BY(my_async_function) internal_buf;
  with(internal_buf)
    Promise p = my_async_function();
  /* this is a null-terminated array, but is really should be
     CollectionsList eventLoopWaitsForThese = [p]; 
     and let c42.collections.policy control what it gets to be physically */
  Promise eventLoopWaitsForThese[2] = {p, NULL};
  basic_usleep_event_loop(eventLoopWaitsForThese);
  return 0;
}

/* by the way async void implicitly returns a Promise to put a void in the
 * Promise's void* when the function returns.  this feeds into the exception
 * bubbling concept, that an unhandled rejection in the function could cause
 * rejections and cancellations from the function */  
async void my_async_function() {
  /* by the way, if callbacker_read had a Promise api instead of a callback
   * api, tracking its state with an explicit Promises would not be necessary */
  Promise p = newPromise();
  _context int bufSz = 1024;
  _context char *buf = malloc(bufSz);
  if(buf == NULL) exit(1);
  /* it is mandatory that foo and extern int SuspendContextSize_foo end up in
   * the same c11 file, then anyone who can see foo to call it can also
   * allocate a buffer for foo.  extern int SuspendContextSize_foo can be
   * declared in the header, but it becomes available when the code is linked */
  _context SuspendContext_callbacker_read callbacker_read_context;
  /* if you dont give your closure a name, it will default to
   * Closure_my_function_1 instead of Closure_my_function_foo */
  _context NEXT_CLOSURE_STORAGE closureStorageAllocation;
  with(callbacker_read_context)
    ^() cancel_handle = callbacker_read("test.txt", buf, bufSz, 0, with(closureStorageAllocation)^foo(int bytes, char* error){
      _context int nread = bytes;
      bytes > 0 ? promise_resolve(p, NULL) : promise_reject(p, error);
    });

  /* naturally, bull is already static, but theres no harm in declaring it */
  static char* bull[] = {
    "the law of large numbers says the d/dx particles are orthogonal and couple to sqrt(t)",
    "given M and ρ, the metric is chosen to maximize the number of graviton modes",
    NULL
  };
  _context char* s[] = bull;
  do {
    Promise timeout = promise_timeout_reject(1_000_000);
    /* the meaning of try/catch/else to transpile down to an if statement
      * checking the status of promise(s) awaited in the try.  the reason is
      * the transpiler can uses that to try to bubble exceptions up or give
      * them to a global uncaught rejection handler */
    try {
      /* promise_race allocates n back pointers in the SuspendContext
       * subscriptions array then does promise_unsubscribe for each of them
       * when the SuspendContext is pinged */
      await PROMISE_RACE(p,timeout);
    } catch (e) {
      /* magical printf flags for error handling: %er for code message, %erb for code message backtrace if backtrace is available like c42.errorPolicy.fulltrace */
      printf("Error reading file: %erb\n", e);
      /* direct a CancellationException to the closures catch{} block */
      await CLOSURE_CANCEL(callbacker_read_context.closureStorageAllocation);
      free(buf);
      exit(2);
    } else {
      /* we can read from our named closure */
      printf("Read %d bytes: %s\n", foo->nread, buf);
      /* promise_cancel does a promise_reject with a CancellationException */
      promise_cancel(timeout);
      free(buf);
      return;
    }
  } while(*s != NULL && printf("%s\n", *s) && s++);
}