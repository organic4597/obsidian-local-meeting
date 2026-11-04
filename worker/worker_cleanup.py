"""Every cleanup is attempted, even when capture shutdown itself fails."""
def cleanup(actions,on_error=None):
    errors=[]
    for name,action in actions:
        try:action()
        except Exception as e:
            errors.append(f'{name}: {e}')
            if on_error:on_error(errors[-1])
    return errors
