
// Here an exemple for an API service.
module.exports = {
  // This method is optionnal, without it the service is instantiate as a singleton.
  // Provide a unique key if you want to build a new instance, or null is the service must me reinstantiate for every request (recommanded for tiny service class)
  scope(req) { 
    return req.session.ssid
  },
  data() {
    // Initialize service state
    return {
      loaded: false,
    }
  },
  setup() {
    // At startup, initialize the service if necessary
    // can run either synchronously or asynchronously
    this.loadExtenalData()
      .then(res => {
        this.loaded = true;
      });
  },
  methods: {
    throwIfNotReady() {
      // Usefull if the method 'setup' start asynchronous loading.
      // Unnecessary if the setup method is synchronous!
      if (!this.loaded)
        throw { httpStatus: 503, message: 'Service not ready - try again later' }
    },
    loadExtenalData() {
      return new Promise((resolve, reject) => {
        // ...
      });
    }
  },
  // Create GET routes
  GET: {
    '/object/:uid': function(query) {
      this.throwIfNotReady();
      if (!this.data[query.uid])
        throw { httpStatus: 404, message: 'Not found' }
      // Return requested data...
      return this.data[query.uid];
    },
    '/async/:uid': function(query) {
      this.throwIfNotReady();
      // Method can be either synchronous or asynchronous
      return new Promise((resolve, reject) => {
        if (!this.data[query.uid])
          // You can also replace 'message' by data: { } to return a JSON object
          return reject({ httpStatus: 404, data: { message: 'Not found', key: query.uid }})
        // Return requested data...
        resolve(this.data[query.uid]);
      });
    }
  },
  // Create POST routes
  POST: {
    '/object/:uid': function(query, body) {
      this.throwIfNotReady();
      if (!this.data[query.uid])
        throw { httpStatus: 404, message: 'Not found' }
      // ...
      return undefined; // Will return 201 if the function return evaluate to false.
    }
  }
}

