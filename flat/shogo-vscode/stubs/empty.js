function noop() {}
function identity(value) { return value; }
function createContext(defaultValue) {
  return {
    Provider: function Provider(props) { return props && props.children ? props.children : null; },
    Consumer: function Consumer(props) { return props && typeof props.children === "function" ? props.children(defaultValue) : null; },
    _currentValue: defaultValue
  };
}

const exportsObject = {
  __esModule: true,
  default: noop,
  createContext,
  createElement: noop,
  cloneElement: noop,
  memo: identity,
  forwardRef: identity,
  Fragment: "Fragment",
  useCallback: identity,
  useContext: function useContext(ctx) { return ctx ? ctx._currentValue : undefined; },
  useEffect: noop,
  useLayoutEffect: noop,
  useMemo: function useMemo(factory) { return typeof factory === "function" ? factory() : factory; },
  useRef: function useRef(value) { return { current: value }; },
  useState: function useState(value) { return [value, noop]; },
  action: identity,
  computed: identity,
  makeAutoObservable: noop,
  makeObservable: noop,
  observable: identity,
  reaction: noop,
  runInAction: function runInAction(fn) { return typeof fn === "function" ? fn() : undefined; }
};

module.exports = exportsObject;
