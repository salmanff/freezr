/**
 * Simple mock utilities to replace Sinon
 * Provides basic mocking, stubbing, and spy functionality
 */

/**
 * Creates a mock function that tracks calls and returns specified values
 * @param {*} returnValue - Value to return when called
 * @returns {Object} Mock function with call tracking
 */
export function createMock(returnValue = undefined) {
  const calls = []
  const mock = function (...args) {
    calls.push({
      args,
      timestamp: Date.now(),
      this: this
    })
    
    if (mock._throwError) {
      throw mock._throwError
    }
    
    return returnValue
  }
  
  mock.calls = calls
  mock.callCount = () => calls.length
  mock.called = () => calls.length > 0
  mock.calledOnce = () => calls.length === 1
  mock.calledTwice = () => calls.length === 2
  mock.calledThrice = () => calls.length === 3
  mock.firstCall = () => calls[0]
  mock.lastCall = () => calls[calls.length - 1]
  mock.getCall = (index) => calls[index]
  mock.reset = () => {
    calls.length = 0
  }
  mock.returns = (value) => {
    mock._returnValue = value
    return mock
  }
  
  mock.throws = (error) => {
    mock._throwError = error
    return mock
  }
  
  return mock
}

/**
 * Creates a spy that wraps an existing function
 * @param {Function} fn - Function to spy on
 * @returns {Function} Spied function with call tracking
 */
export function spy(fn) {
  const calls = []
  const spied = function (...args) {
    calls.push({
      args,
      timestamp: Date.now(),
      this: this
    })
    return fn.apply(this, args)
  }
  
  spied.calls = calls
  spied.callCount = () => calls.length
  spied.called = () => calls.length > 0
  spied.calledOnce = () => calls.length === 1
  spied.calledTwice = () => calls.length === 2
  spied.calledThrice = () => calls.length === 3
  spied.firstCall = () => calls[0]
  spied.lastCall = () => calls[calls.length - 1]
  spied.getCall = (index) => calls[index]
  spied.reset = () => {
    calls.length = 0
  }
  
  return spied
}

/**
 * Creates a stub that replaces a method on an object
 * @param {Object} obj - Object to stub method on
 * @param {string} method - Method name to stub
 * @param {*} returnValue - Value to return
 * @returns {Function} Stub function
 */
export function stub(obj, method, returnValue = undefined) {
  const original = obj[method]
  const stubFn = createMock(returnValue)
  
  obj[method] = stubFn
  stubFn.restore = () => {
    obj[method] = original
  }
  
  return stubFn
}

/**
 * Creates a mock object with specified methods
 * @param {Object} methods - Object with method names and return values
 * @returns {Object} Mock object
 */
export function createMockObject(methods = {}) {
  const mock = {}
  
  for (const [method, returnValue] of Object.entries(methods)) {
    mock[method] = createMock(returnValue)
  }
  
  return mock
}

/**
 * Asserts that a mock was called with specific arguments
 * @param {Function} mock - Mock function
 * @param {number} callIndex - Call index (0 for first call)
 * @param {Array} expectedArgs - Expected arguments
 */
export function assertCalledWith(mock, callIndex = 0, expectedArgs = []) {
  const call = mock.getCall(callIndex)
  if (!call) {
    throw new Error(`Mock was not called ${callIndex + 1} times`)
  }
  
  if (call.args.length !== expectedArgs.length) {
    throw new Error(`Expected ${expectedArgs.length} arguments, got ${call.args.length}`)
  }
  
  for (let i = 0; i < expectedArgs.length; i++) {
    if (call.args[i] !== expectedArgs[i]) {
      throw new Error(`Argument ${i} mismatch: expected ${expectedArgs[i]}, got ${call.args[i]}`)
    }
  }
}

/**
 * Asserts that a mock was called a specific number of times
 * @param {Function} mock - Mock function
 * @param {number} expectedCalls - Expected number of calls
 */
export function assertCallCount(mock, expectedCalls) {
  const actualCalls = mock.callCount()
  if (actualCalls !== expectedCalls) {
    throw new Error(`Expected ${expectedCalls} calls, got ${actualCalls}`)
  }
} 