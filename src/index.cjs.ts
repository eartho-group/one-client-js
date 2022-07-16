import createEarthoOne, {
  EarthoOne,
  GenericError,
  AuthenticationError,
  TimeoutError,
  PopupTimeoutError,
  MfaRequiredError
} from './index';

/**
 * @ignore
 */
const wrapper = createEarthoOne as any;

wrapper.EarthoOne = EarthoOne;
wrapper.createEarthoOne = createEarthoOne;
wrapper.GenericError = GenericError;
wrapper.AuthenticationError = AuthenticationError;
wrapper.TimeoutError = TimeoutError;
wrapper.PopupTimeoutError = PopupTimeoutError;
wrapper.MfaRequiredError = MfaRequiredError;

export default wrapper;
