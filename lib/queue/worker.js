/*!
 * kue - Worker
 * Copyright (c) 2011 LearnBoost <tj@learnboost.com>
 * MIT Licensed
 */

/**
 * Module dependencies.
 */

var EventEmitter = require('events').EventEmitter
    , redis = require('../redis')
    , events = require('./events')
    , Job = require('./job')
    , _ = require('lodash')
    , domain = require('domain');

/**
 * Expose `Worker`.
 */

module.exports = Worker;

/**
 * Redis connections used by `getJob()` when blocking.
 */

var clients = {};

/**
 * Initialize a new `Worker` with the given Queue
 * targetting jobs of `type`.
 *
 * @param {Queue} queue
 * @param {String} type
 * @api private
 */

function Worker(queue, type) {
    this.queue = queue;
    this.type = type;
    this.client = Worker.client || (Worker.client = redis.createClient());
    this.running = true;
    this.job = null;
}

/**
 * Inherit from `EventEmitter.prototype`.
 */

Worker.prototype.__proto__ = EventEmitter.prototype;

/**
 * Start processing jobs with the given `fn`,
 *
 * @param {Function} fn
 * @return {Worker} for chaining
 * @api private
 */

Worker.prototype.start = function (fn) {
    var self = this;
    self.job = null;
    if (!self.running) return;
    self.getJob(function (err, job) {
        if (err) self.error(err, job);
        if (!job || err) return process.nextTick(function () {
            self.start(fn);
        });
        self.job = job;
        self.process(job, fn);
    });
    return this;
};

/**
 * Error handler, currently does nothing.
 *
 * @param {Error} err
 * @param {Job} job
 * @return {Worker} for chaining
 * @api private
 */

Worker.prototype.error = function (err, job) {
    var errorObj = err;
    if( err.stack ) {
        errorObj = { stack:err.stack, message:err.message };
    }
    this.emit('error', errorObj, job);
//    console.error(err.stack || err.message || err);
    return this;
};

/**
 * Process a failed `job`. Set's the job's state
 * to "failed" unless more attempts remain, in which
 * case the job is marked as "inactive" and remains
 * in the queue.
 *
 * @param {Function} fn
 * @return {Worker} for chaining
 * @api private
 */

Worker.prototype.failed = function (job, err, fn) {
    var self = this;
    job.error(err).failed( function(){
        job.attempt(function (error, remaining, attempts, max) {
            if (error) return self.error(error, job);
            if (remaining) {
                var emit = function () {
                    self.emit('job failed attempt', job);
                    events.emit(job.id, 'failed attempt', attempts);
                };

                if ( job.backoff() ) {
                    var delay = job.delay();
                    if( _.isFunction( job._getBackoffImpl() ) ) {
                        try {
                            delay = job._getBackoffImpl().apply( job, [attempts] );
                        } catch( e ) {
                            self.error( e, job );
                        }
                    }
                    job.delay(delay).update().delayed(emit);
                } else {
                    job.inactive(emit);
                }
            } else {
                self.emit('job failed', job);
                events.emit(job.id, 'failed');
            }
            self.start(fn);
        }.bind(this));
    }.bind(this));
};

/**
 * Process `job`, marking it as active,
 * invoking the given callback `fn(job)`,
 * if the job fails `Worker#failed()` is invoked,
 * otherwise the job is marked as "complete".
 *
 * @param {Job} job
 * @param {Function} fn
 * @return {Worker} for chaining
 * @api public
 */

Worker.prototype.process = function (job, fn) {
    var self = this
        , start = new Date();
    job.active( function(){
        fn(
            job,
            function (err, result) {
                if (err) {
                    return self.failed(job, err, fn);
                }
                job.set('duration', job.duration = new Date - start);
                if( result ) {
                    try{
                        job.result = result;
                        job.set('result', JSON.stringify(result));
                    }catch(e){
                        job.set('result', JSON.stringify({error: true, message:'Invalid JSON Result: "' + result + '"' }));
                    }
                }
                job.complete( function(){
                    job.attempt( function(){
                        self.emit('job complete', job);
                        events.emit(job.id, 'complete', result);
                        if( job.removeOnComplete() ) {
                            job.remove();
                        }
                    });
                }.bind(this));
                self.start(fn);
            },{
                /**
                 * @author behrad
                 * @pause: let the processor to tell worker not to continue processing new jobs
                 */
                pause: function( fn, timeout ){
                    timeout = timeout || 5000;
                    self.queue.shutdown( fn, Number(timeout), self.type);
                },
                /**
                 * @author behrad
                 * @pause: let the processor to trigger restart for they job processing
                 */
                resume: function () {
                    if (self.resume()) {
                        self.start(fn);
                    }
                }
            }
        );
    }.bind(this));
    return this;
};

/**
 * Atomic ZPOP implementation.
 *
 * @param {String} key
 * @param {Function} fn
 * @api private
 */

Worker.prototype.zpop = function (key, fn) {
    this.client
        .multi()
        .zrange(key, 0, 0)
        .zremrangebyrank(key, 0, 0)
        .exec(function (err, res) {
            if (err) return fn(err);
            var id = res[0][0];
            fn(null, id);
        });
};

/**
 * Attempt to fetch the next job.
 *
 * @param {Function} fn
 * @api private
 */

Worker.prototype.getJob = function (fn) {
    var self = this;

    // alloc a client for this job type
    var client = clients[self.type]
        || (clients[self.type] = redis.createClient());

    if (!self.running) {
        return fn("Already Shutdown");
    }
    // BLPOP indicates we have a new inactive job to process
    client.blpop(client.getKey(self.type + ':jobs'), 0, function (err) {
        if (err || !self.running) {
            client.lpush(client.getKey(self.type + ':jobs'), 1);
            return fn(err);		// SAE: Added to avoid crashing redis on zpop
        }
        // Set job to a temp value so shutdown() knows to wait
        self.job = true;
        self.zpop(client.getKey('jobs:' + self.type + ':inactive'), function (err, id) {
            if (err || !id) {
                self.job = null;
                return fn(err /*|| "No job to pop!"*/);
            }
            Job.get(id, fn);
        });
    });
};

/**
 * Gracefully shut down the worker
 *
 * @param {Function} fn
 * @param {int} timeout
 * @api private
 */

Worker.prototype.shutdown = function (fn, timeout) {
    var self = this, shutdownTimer = null;

    // Wrap `fn` so we don't pass `job` to it
    var _fn = function (job) {
        if( job && self.job && job.id != self.job.id ) {
            return; // simply ignore older job events currently being received until the right one comes...
        }
        shutdownTimer && clearTimeout(shutdownTimer);
        self.removeAllListeners();
        self.job = null;
        //fix half-blob job fetches if any...
        self.client.lpush(self.client.getKey(self.type + ':jobs'), 1);
        //Safeyly kill any blpop's that are waiting.
        (self.type in clients) && clients[self.type].quit();
        delete clients[self.type];
        fn();
    };
    if (!this.running) return _fn();
    this.running = false;

    // As soon as we're free, signal that we're done
    if (!this.job) {
        return _fn();
    }
    this.on('job complete', _fn);
    this.on('job failed', _fn);
    this.on('job failed attempt', _fn);

    if (timeout) {
        shutdownTimer = setTimeout(function () {
            if (self.job) {
                if( self.job !== true ) {
                    // a job is running - fail it and call _fn when complete
                    self.failed( self.job, { error: true, message: "Shutdown" }, _fn);
                }
            } else {
                // no job running - just finish immediately
                _fn();
            }
        }.bind( this ), timeout);
    }
};

Worker.prototype.resume = function () {
    if (this.running) return false;
    this.running = true;
    return true;
};
